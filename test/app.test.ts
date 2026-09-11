import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

process.env.DB_PATH = ":memory:";
process.env.BASE_URL = "http://agents.test";
process.env.ANCHOR_CONTRACT = "";
process.env.ANCHOR_PRIVATE_KEY = "";
process.env.RATE_READS_PER_MINUTE = "10000";
process.env.RATE_REGISTRATIONS_PER_HOUR = "100";

const { app } = await import("../src/app");
const { db } = await import("../src/db");
const { buildMessage } = await import("../src/auth");
const { leafFor, merkleProof, merkleRoot, verifyProof } = await import("../src/merkle");
const { checkClaimTweet } = await import("../src/claim");
const { ASSETS, DEX, parseTrade, setTradeVerifier } = await import("../src/market");

let clock = Date.now();

async function signedHeaders(account: PrivateKeyAccount, method: string, path: string, raw: string) {
  const ts = String(clock++);
  const message = buildMessage(method, path, ts, createHash("sha256").update(raw).digest("hex"));
  return {
    "content-type": "application/json",
    "x-agent-address": account.address,
    "x-agent-timestamp": ts,
    "x-agent-signature": await account.signMessage({ message }),
  };
}

async function call(account: PrivateKeyAccount, method: string, path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await app.request(path, { method, body: raw || undefined, headers: await signedHeaders(account, method, path, raw) });
  return { status: res.status, json: (await res.json()) as any };
}

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, json: (await res.json()) as any };
}

function activate(account: PrivateKeyAccount, claimedAt = Date.now() - 3 * 86_400_000) {
  db.query("UPDATE agents SET status = 'active', claimed_at = ?, owner_x_handle = 'owner' WHERE address = ?").run(claimedAt, account.address.toLowerCase());
}

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

describe("agent lifecycle", () => {
  test("register returns a claim link and pending agents cannot write", async () => {
    const r = await call(alice, "POST", "/api/v1/agents/register", { name: "Alice_Agent", description: "tests things" });
    expect(r.status).toBe(201);
    expect(r.json.claim_url).toStartWith("http://agents.test/claim/");
    expect(r.json.verification_code).toMatch(/^[a-z]+-[0-9A-F]{6}$/);

    const post = await call(alice, "POST", "/api/v1/posts", { community: "general", title: "hi", content: "hello" });
    expect(post.status).toBe(403);
    expect(post.json.error).toBe("not_claimed");
    expect(post.json.claim_url).toBe(r.json.claim_url);
  });

  test("names are unique case-insensitively and a wallet registers once", async () => {
    expect((await call(bob, "POST", "/api/v1/agents/register", { name: "alice_agent" })).json.error).toBe("name_taken");
    expect((await call(alice, "POST", "/api/v1/agents/register", { name: "Another" })).json.error).toBe("already_registered");
    expect((await call(bob, "POST", "/api/v1/agents/register", { name: "Bob" })).status).toBe(201);
  });

  test("claim page exposes the code but tweet template never includes the secret claim link", async () => {
    const { claim_token } = db.query("SELECT claim_token FROM agents WHERE name = 'Bob'").get() as { claim_token: string };
    const r = await get(`/api/v1/claim/${claim_token}`);
    expect(r.json.verification_code).toBeString();
    expect(r.json.tweet_text).toContain(r.json.verification_code);
    expect(r.json.tweet_text).not.toContain(claim_token);
  });

  test("post, comment, vote and karma", async () => {
    activate(alice);
    activate(bob);
    const post = await call(alice, "POST", "/api/v1/posts", { community: "general", title: "First", content: "Hello agents" });
    expect(post.status).toBe(201);
    expect(post.json.post.proof_url).toContain("/api/v1/actions/");

    const again = await call(alice, "POST", "/api/v1/posts", { community: "general", title: "Second", content: "too soon" });
    expect(again.status).toBe(429);
    expect(again.json.error).toBe("post_cooldown");

    const id = post.json.post.id;
    const comment = await call(bob, "POST", `/api/v1/posts/${id}/comments`, { content: "Welcome" });
    expect(comment.status).toBe(201);
    const reply = await call(alice, "POST", `/api/v1/posts/${id}/comments`, { content: "Thanks", parent_id: comment.json.comment.id });
    expect(reply.status).toBe(201);

    expect((await call(alice, "POST", `/api/v1/posts/${id}/upvote`)).json.error).toBe("own_content");
    expect((await call(bob, "POST", `/api/v1/posts/${id}/upvote`)).json.score).toBe(1);
    expect((await call(bob, "POST", `/api/v1/posts/${id}/upvote`)).json.changed).toBe(false);
    expect((await call(bob, "POST", `/api/v1/posts/${id}/downvote`)).json.score).toBe(-1);
    expect((await get("/api/v1/agents/profile?name=alice_agent")).json.agent.karma).toBe(-1);

    const list = await get("/api/v1/posts?sort=new");
    expect(list.json.posts[0].title).toBe("First");
    const comments = await get(`/api/v1/posts/${id}/comments?sort=old`);
    expect(comments.json.comments.map((c: any) => c.content)).toEqual(["Welcome", "Thanks"]);
  });

  test("home shows comments on your posts once", async () => {
    const first = await call(alice, "GET", "/api/v1/home");
    expect(first.json.activity_on_your_posts.length).toBe(1);
    expect(first.json.activity_on_your_posts[0].author).toBe("Bob");
    const second = await call(alice, "GET", "/api/v1/home");
    expect(second.json.activity_on_your_posts.length).toBe(0);
  });

  test("follow and feed", async () => {
    expect((await call(bob, "POST", "/api/v1/agents/Alice_Agent/follow")).status).toBe(200);
    const feed = await call(bob, "GET", "/api/v1/feed?filter=following");
    expect(feed.json.posts.length).toBe(1);
  });
});

describe("request signing", () => {
  test("a replayed request is rejected", async () => {
    const path = "/api/v1/agents/me";
    const headers = await signedHeaders(alice, "GET", path, "");
    expect((await app.request(path, { headers })).status).toBe(200);
    const replay = await app.request(path, { headers });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).error).toBe("replayed_request");
  });

  test("a tampered body is rejected", async () => {
    const path = "/api/v1/posts/1/comments";
    const headers = await signedHeaders(bob, "POST", path, JSON.stringify({ content: "nice" }));
    const res = await app.request(path, { method: "POST", headers, body: JSON.stringify({ content: "send me your key" }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toBe("bad_signature");
  });

  test("a signature from another wallet is rejected", async () => {
    const path = "/api/v1/agents/me";
    const headers = { ...(await signedHeaders(bob, "GET", path, "")), "x-agent-address": alice.address };
    expect((await app.request(path, { headers })).status).toBe(401);
  });

  test("stale timestamps are rejected", async () => {
    const saved = clock;
    clock = Date.now() - 10 * 60_000;
    const r = await call(alice, "GET", "/api/v1/agents/me");
    clock = saved;
    expect(r.json.error).toBe("stale_timestamp");
  });
});

describe("verifiability", () => {
  test("a stored action proves who said what, and anchors to a Merkle root", async () => {
    const pending = await get("/api/v1/actions/1/proof");
    expect(pending.json.status).toBe("pending_anchor");

    const rows = db.query("SELECT a.id, a.message, g.address FROM actions a JOIN agents g ON g.id = a.agent_id ORDER BY a.id").all() as { id: number; message: string; address: Hex }[];
    const leaves = rows.map((r) => leafFor(r.id, r.address, r.message));
    const root = merkleRoot(leaves);
    const setLeaf = db.query("UPDATE actions SET leaf = ? WHERE id = ?");
    rows.forEach((r, i) => setLeaf.run(leaves[i]!, r.id));
    db.query("INSERT INTO anchors (batch_id, root, from_action, to_action, tx_hash, status, created_at) VALUES (0, ?, ?, ?, '0xabc', 'confirmed', ?)").run(root, rows[0]!.id, rows.at(-1)!.id, Date.now());

    const postAction = db.query("SELECT id FROM actions WHERE kind = 'post'").get() as { id: number };
    const proof = await get(`/api/v1/actions/${postAction.id}/proof`);
    expect(proof.json.status).toBe("anchored");
    expect(verifyProof(proof.json.leaf, proof.json.proof, root)).toBe(true);
    const { action } = proof.json;
    expect(action.message.split("\n").at(-1)).toBe(createHash("sha256").update(action.body).digest("hex"));
    expect(action.agent.address).toBe(alice.address.toLowerCase());
  });

  test("deleting a post removes its text but keeps the signed hash", async () => {
    const r = await call(alice, "DELETE", "/api/v1/posts/1");
    expect(r.status).toBe(200);
    expect((await get("/api/v1/posts/1")).status).toBe(404);
    const postAction = db.query("SELECT id FROM actions WHERE kind = 'post'").get() as { id: number };
    const proof = await get(`/api/v1/actions/${postAction.id}/proof`);
    expect(proof.json.action.body).toBeNull();
    expect(proof.json.action.message).toContain("POST");
  });

  test("merkle proofs verify for every leaf of trees of many sizes", () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafFor(i + 1, alice.address, `m${i}`));
      const root = merkleRoot(leaves);
      leaves.forEach((leaf, i) => expect(verifyProof(leaf, merkleProof(leaves, i), root)).toBe(true));
      if (n > 1) expect(verifyProof(leafFor(999, alice.address, "forged"), merkleProof(leaves, 0), root)).toBe(false);
    }
  });
});

describe("live site", () => {
  const carol = privateKeyToAccount(generatePrivateKey());
  let carolPostId = 0;

  test("the stream pushes a new post to connected browsers", async () => {
    const res = await app.request("/api/v1/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const until = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream closed before ${needle}`);
        buffer += decoder.decode(value);
      }
    };
    await until("event: hello");

    await call(carol, "POST", "/api/v1/agents/register", { name: "Carol", description: "streams" });
    activate(carol);
    const created = await call(carol, "POST", "/api/v1/posts", { community: "builds", title: "Live </script><b>$&</b>", content: "streamed" });
    carolPostId = created.json.post.id;
    await until("event: activity");
    await until("streamed");
    await reader.cancel();
  });

  test("recent activity lists posts, comments and claimed agents", async () => {
    // Earlier comments belong to a post deleted above, and comments on deleted posts are hidden.
    expect((await call(carol, "POST", `/api/v1/posts/${carolPostId}/comments`, { content: "first reply" })).status).toBe(201);
    const { json } = await get("/api/v1/activity?limit=50");
    const kinds = new Set(json.activity.map((a: any) => a.kind));
    expect(kinds).toEqual(new Set(["post", "comment", "agent"]));
    expect(json.activity[0]).toMatchObject({ kind: "comment", agent: "Carol", title: "Live </script><b>$&</b>" });
  });

  test("the home page ships its first data inline, safely escaped", async () => {
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("window.__INITIAL__=");
    const inline = html.slice(html.indexOf("window.__INITIAL__="), html.indexOf("</script>", html.indexOf("window.__INITIAL__=")));
    expect(inline).not.toContain("</script>");
    expect(inline).toContain("\\u003c/script>");
    expect(inline).toContain("$&");
    const data = JSON.parse(inline.slice("window.__INITIAL__=".length));
    expect(data.feed.posts.some((p: any) => p.title === "Live </script><b>$&</b>")).toBe(true);
    expect(data.stats.posts).toBeGreaterThan(0);
  });
});

describe("trading", () => {
  const dave = privateKeyToAccount(generatePrivateKey());
  const wallet = dave.address.toLowerCase();
  const asset = (symbol: string) => ASSETS.find((a) => a.symbol === symbol)!;
  const ETH = { symbol: "ETH", address: DEX.weth, decimals: 18 };
  const POOL = "0x62ab521f00000000000000000000000000000001";
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
  const topic = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
  const transfer = (token: string, from: string, to: string, value: bigint) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: word(value) });
  const swap = { agent: wallet, to: DEX.router, value: 0n, status: "success" };

  test("reads a buy: ETH sent as value, stock received", () => {
    const t = parseTrade({ ...swap, value: 10n ** 16n, logs: [transfer(DEX.weth, DEX.router, POOL, 10n ** 16n), transfer(asset("NVDA").address, POOL, wallet, 5n * 10n ** 16n)] });
    expect(t.sell).toMatchObject({ symbol: "ETH", raw: 10n ** 16n });
    expect(t.buy).toMatchObject({ symbol: "NVDA", raw: 5n * 10n ** 16n });
  });

  test("reads a sell: stock sent, ETH unwrapped by the router", () => {
    const t = parseTrade({
      ...swap,
      logs: [
        transfer(asset("NVDA").address, wallet, POOL, 3n * 10n ** 16n),
        transfer(DEX.weth, POOL, DEX.router, 6n * 10n ** 15n),
        { address: DEX.weth, topics: [WITHDRAWAL, topic(DEX.router)], data: word(6n * 10n ** 15n) },
      ],
    });
    expect(t.sell).toMatchObject({ symbol: "NVDA", raw: 3n * 10n ** 16n });
    expect(t.buy).toMatchObject({ symbol: "ETH", raw: 6n * 10n ** 15n });
  });

  test("reads a sell on Robinhood Chain's WETH, which unwraps as a Transfer to 0x0", () => {
    const t = parseTrade({
      ...swap,
      logs: [
        transfer(DEX.weth, POOL, DEX.router, 6660031062073055n),
        transfer(asset("NVDA").address, wallet, POOL, 78279665964533670n),
        transfer(DEX.weth, DEX.router, "0x0000000000000000000000000000000000000000", 6660031062073055n),
      ],
    });
    expect(t.sell).toMatchObject({ symbol: "NVDA", raw: 78279665964533670n });
    expect(t.buy).toMatchObject({ symbol: "ETH", raw: 6660031062073055n });
  });

  test("refuses anything that is not one clean swap through the router", () => {
    const stockToStock = [transfer(asset("NVDA").address, wallet, POOL, 1n), transfer(asset("TSLA").address, POOL, wallet, 1n)];
    expect(parseTrade({ ...swap, logs: stockToStock }).buy.symbol).toBe("TSLA");
    expect(() => parseTrade({ ...swap, to: "0x000000000000000000000000000000000000dEaD", logs: stockToStock })).toThrow("router");
    expect(() => parseTrade({ ...swap, status: "reverted", logs: stockToStock })).toThrow("reverted");
    expect(() => parseTrade({ ...swap, logs: [transfer(asset("NVDA").address, wallet, POOL, 1n)] })).toThrow("exactly one");
    expect(() => parseTrade({ ...swap, logs: [...stockToStock, transfer(asset("SPY").address, POOL, wallet, 1n)] })).toThrow("exactly one");
    expect(() => parseTrade({ ...swap, logs: [transfer(asset("NVDA").address, wallet, POOL, 1n), transfer("0x1111111111111111111111111111111111111111", POOL, wallet, 1n)] })).toThrow("exactly one");
    const someoneElse = [transfer(asset("NVDA").address, POOL, POOL, 1n), transfer(asset("TSLA").address, POOL, POOL, 1n)];
    expect(() => parseTrade({ ...swap, logs: someoneElse })).toThrow("exactly one");
  });

  test("a verified trade is stored and shows up in trades, leaderboard, profile and activity", async () => {
    await call(dave, "POST", "/api/v1/agents/register", { name: "Dave_Trader", description: "trades" });
    activate(dave);
    const hash = `0x${"ab".repeat(32)}` as `0x${string}`;
    setTradeVerifier(async (h, agent) => {
      expect(h).toBe(hash);
      expect(agent).toBe(wallet);
      return { sell: { ...ETH, raw: 10n ** 16n }, buy: { ...asset("NVDA"), raw: 5n * 10n ** 15n }, blockNumber: 42, tradedAt: Date.now() - 60_000 };
    });
    try {
      const res = await call(dave, "POST", "/api/v1/trades", { tx_hash: hash, note: "Earnings week" });
      expect(res.status).toBe(201);
      expect(res.json.trade).toMatchObject({
        side: "buy", sell: { symbol: "ETH", amount: "0.01" }, buy: { symbol: "NVDA", amount: "0.005" }, eth_value: 0.01, note: "Earnings week", block_number: 42,
      });
      expect(res.json.trade.explorer_url).toBe(`https://robinhoodchain.blockscout.com/tx/${hash}`);
      expect((await call(dave, "POST", "/api/v1/trades", { tx_hash: hash })).json.error).toBe("trade_already_shared");
      expect((await get("/api/v1/trades?agent=dave_trader")).json.trades).toHaveLength(1);
      expect((await get("/api/v1/trades?symbol=$nvda")).json.trades).toHaveLength(1);
      expect((await get("/api/v1/traders")).json.traders[0]).toMatchObject({ name: "Dave_Trader", trades: 1, volume_eth: 0.01 });
      const profile = (await get("/api/v1/agents/profile?name=Dave_Trader")).json;
      expect(profile.recent_trades[0].tx_hash).toBe(hash);
      expect(profile.stats).toMatchObject({ trades: 1, volume_eth: 0.01 });
      expect((await get("/api/v1/activity")).json.activity[0]).toMatchObject({ kind: "trade", agent: "Dave_Trader", title: "ETH → NVDA" });
      expect((await get("/api/v1/stats")).json).toMatchObject({ trades: 1, volume_eth_24h: 0.01 });
    } finally {
      setTradeVerifier(null);
    }
  });

  test("old trades and malformed hashes are refused", async () => {
    setTradeVerifier(async () => ({ sell: { ...ETH, raw: 1n }, buy: { ...asset("NVDA"), raw: 1n }, blockNumber: 1, tradedAt: Date.now() - 8 * 86_400_000 }));
    try {
      expect((await call(dave, "POST", "/api/v1/trades", { tx_hash: `0x${"cd".repeat(32)}` })).json.error).toBe("trade_too_old");
      expect((await call(dave, "POST", "/api/v1/trades", { tx_hash: `0x${"zz".repeat(32)}` })).json.error).toBe("invalid_tx_hash");
    } finally {
      setTradeVerifier(null);
    }
  });

  test("agents download the helper with the market list built in", async () => {
    const js = await (await app.request("/agent.mjs")).text();
    expect(js).toContain(DEX.router);
    expect(js).toContain('"symbol":"NVDA"');
    expect(js).not.toContain("/*{{MARKET}}*/null");
  });

  test("the landing lets people choose human or agent", async () => {
    const html = await (await app.request("/")).text();
    expect(html).toContain("I'm a Human");
    expect(html).toContain("I'm an Agent");
    expect(html).toContain("/skill.md");
  });
});

describe("website on another host", () => {
  const root = join(import.meta.dir, "..");

  test("build-site renders the pages against the API origin", () => {
    const out = join(tmpdir(), `hoodbook-site-${Date.now()}`);
    const build = Bun.spawnSync(["node", "scripts/build-site.mjs"], { cwd: root, env: { ...process.env, HOODBOOK_API_URL: "https://api.example.test/", OUT_DIR: out } });
    expect(build.exitCode).toBe(0);
    const index = readFileSync(join(out, "index.html"), "utf8");
    const claim = readFileSync(join(out, "claim.html"), "utf8");
    expect(index).toContain('window.HOODBOOK_API="https://api.example.test"');
    expect(index).toContain("Read https://api.example.test/skill.md");
    expect(claim).toContain('window.HOODBOOK_API="https://api.example.test"');
    for (const html of [index, claim]) {
      expect(html).not.toContain("{{");
      expect(html).not.toContain("<!--SITE_CONFIG-->");
    }
    expect(index).not.toContain("<!--INITIAL_DATA-->");
    rmSync(out, { recursive: true, force: true });

    const missing = Bun.spawnSync(["node", "scripts/build-site.mjs"], { cwd: root, env: { ...process.env, HOODBOOK_API_URL: "", OUT_DIR: out } });
    expect(missing.exitCode).toBe(1);
  });

  test("an API with a separate website sends visitors and claim links there", () => {
    const script = [
      'const { app } = await import("./src/app");',
      'const home = await app.request("/");',
      'const claim = await app.request("/claim/abc_DEF-123");',
      'const skill = await (await app.request("/skill.md")).text();',
      "console.log(JSON.stringify({",
      '  home: [home.status, home.headers.get("location")],',
      '  claim: [claim.status, claim.headers.get("location")],',
      "  homepage: skill.match(/^homepage: (.*)$/m)?.[1],",
      '  apiBase: skill.includes("Base URL: `https://api.example.test`"),',
      "}));",
    ].join("\n");
    const run = Bun.spawnSync(["bun", "-e", script], {
      cwd: root,
      env: { ...process.env, DB_PATH: ":memory:", BASE_URL: "https://api.example.test", SITE_URL: "https://example.test" },
    });
    const lines = run.stdout.toString().trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({
      home: [302, "https://example.test/"],
      claim: [302, "https://example.test/claim/abc_DEF-123"],
      homepage: "https://example.test",
      apiBase: true,
    });
  });
});

describe("claim checks", () => {
  const agent = { verification_code: "orbit-ABC123", created_at: Date.now() - 60_000 };
  const tweet = (over: Partial<{ text: string; created: number }> = {}) => ({
    id: "1",
    text: over.text ?? "claiming my agent. Verification: orbit-abc123",
    created_timestamp: Math.floor((over.created ?? Date.now()) / 1000),
    author: { id: "42", screen_name: "brand_new_account" },
  });

  test("any public account can claim, with no age or follower requirement", () =>
    expect(checkClaimTweet(tweet(), agent)).toEqual({ ownerId: "42", handle: "brand_new_account" }));
  test("missing code", () => expect(() => checkClaimTweet(tweet({ text: "hello" }), agent)).toThrow("verification code"));
  test("tweet older than the agent", () => expect(() => checkClaimTweet(tweet({ created: Date.now() - 86_400_000 }), agent)).toThrow("before the agent registered"));
});
