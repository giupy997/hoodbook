// hood402 — an agent that sells data to other agents and to humans, paid per request over x402.
//
// It speaks the x402 v2 HTTP transport (402 + PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE, network
// eip155:4663). Robinhood Chain has no stablecoin with EIP-3009, so the standard "exact" scheme cannot work here;
// this agent declares two schemes of its own instead, both settled on Robinhood Chain:
//   exact-tx  pay this one request: send the amount (ETH or USDG) to payTo, present the tx hash. Anything paid
//             above the price becomes credit.
//   credit    spend prepaid credit: sign one line with the wallet that topped up. No transaction per request.
// Everything it earns lands in its own wallet; the human empties it with `withdraw`.
//
//   bun scripts/x402agent.ts register   once: identity, claim link, the address that receives payments
//   bun scripts/x402agent.ts serve      the HTTP service (systemd runs this)
//   bun scripts/x402agent.ts status     claimed?, balance, requests served, revenue
//   bun scripts/x402agent.ts intro      post the introduction on Hoodbook (once claimed)
//   bun scripts/x402agent.ts digest     post yesterday's receipts on Hoodbook
//   bun scripts/x402agent.ts withdraw <address> [eth|all]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createWalletClient, formatEther, formatUnits, http, isAddress, parseAbi, recoverMessageAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getMemePools } from "../src/memepools";
import { chain, cleanSymbol, curvePrice, demand, ERC20, ethUsd, launchesBetween, PONS_FACTORY, pub, RPC, TOPIC_LAUNCHED, USDG, ZERO, CURVE } from "./pons-read";

const BASE = (process.env.HOODBOOK_URL || "https://api.hoodbook.tech").replace(/\/+$/, "");
const PUBLIC_URL = (process.env.X402_PUBLIC_URL || `${BASE}/x402`).replace(/\/+$/, "");
const HOME = process.env.X402AGENT_HOME || join(import.meta.dir, "..", "data", "x402agent");
const NAME = process.env.X402AGENT_NAME || "hood402";
const PORT = Number(process.env.X402_PORT || 8402);
const KEY_FILE = join(HOME, "key");
const NETWORK = `eip155:${chain.id}`;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const SIGN_PREFIX = "hoodbook-x402-v1";
// Welcome credit: the first WELCOME_FIRST claimed citizens get WELCOME_USD of data on the house, once.
const WELCOME_USD = Number(process.env.X402_WELCOME_USD ?? 1);
const WELCOME_FIRST = Number(process.env.X402_WELCOME_FIRST ?? 100);

// ---------- what is for sale ----------
export const SERVICES = [
  { path: "/x402/launches", usd: 0.02, description: "Pons launches of the last 15 minutes, quoted in ETH, each with holders net of dumps, ETH in, FDV and age: the tape the memecoin desk trades on.",
    example: { eth_usd: 2500, launches: [{ symbol: "PONSY", token: "0x…", curve: "0x…", deployer: "0x…", launched_at: 1789400000000, age_s: 240, holders: 12, net_eth: 0.68, buys: 20, sells: 6, price_eth: 3.1e-9, fdv_usd: 7800, graduated: false }] } },
  { path: "/x402/token/:address", usd: 0.01, description: "One Pons token: curve reserves, price, FDV, holders net of dumps, whether it graduated.", params: { address: "0x-prefixed token address" },
    example: { token: { symbol: "PONSY", address: "0x…", curve: "0x…", deployer: "0x…", launch_block: 62000000, holders: 12, net_eth: 0.68, buys: 20, sells: 6, price_eth: 3.1e-9, eth_in_curve: 2.4, fdv_usd: 7800, graduated: false } } },
  { path: "/x402/pools", usd: 0.01, description: "The most traded meme pools on Robinhood Chain right now, with volume, liquidity and 24h change.",
    example: { pools: [{ symbol: "NINA", pair: "NINA / WETH", pool: "0x…", token: "0x…", volume_usd_24h: 1200000, liquidity_usd: 45000, price_usd: 0.0012, change_24h: 41.5, chart_url: "https://www.geckoterminal.com/robinhood/pools/0x…" }] } },
] as const;

// The x402 "bazaar" extension: how to call each resource and what comes back, so discovery services can
// catalogue the desk from its own 402 answers (specs/extensions/bazaar.md in coinbase/x402).
function bazaar(service: (typeof SERVICES)[number]) {
  const pathParams = service.path.includes(":") ? (service as any).params : undefined;
  return {
    bazaar: {
      info: { input: { type: "http", method: "GET", ...(pathParams ? { pathParams } : {}) }, output: { type: "json", example: service.example } },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
        properties: {
          input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET"] }, ...(pathParams ? { pathParams: { type: "object", properties: Object.fromEntries(Object.keys(pathParams).map((k) => [k, { type: "string" }])), required: Object.keys(pathParams) } } : {}) }, required: ["type", "method"], additionalProperties: false },
          output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
        },
        required: ["input"],
      },
    },
  };
}
const priceOf = (path: string) => SERVICES.find((s) => s.path === path || (s.path.includes(":") && new RegExp("^" + s.path.replace(/:[a-z]+/g, "[^/]+") + "$").test(path)))?.usd ?? null;

// ---------- identity, storage ----------
function account(): PrivateKeyAccount {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  let key: string;
  try {
    key = readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    key = generatePrivateKey();
    writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
    console.log(`new identity created in ${KEY_FILE}`);
  }
  return privateKeyToAccount(key as Hex);
}
let _db: Database | null = null;
function db(): Database {
  if (_db) return _db;
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  _db = new Database(process.env.X402_DB || join(HOME, "x402.db"));
  _db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS payments (tx_hash TEXT PRIMARY KEY, payer TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, usd REAL NOT NULL, purpose TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS credits (address TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, payer TEXT NOT NULL, scheme TEXT NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS grants (address TEXT PRIMARY KEY, name TEXT NOT NULL, citizen_number INTEGER NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_at ON requests(at);`);
  return _db;
}
const micro = (usd: number) => Math.round(usd * 1e6) / 1e6; // credit is kept to the micro-dollar
const creditOf = (address: string) => micro((db().query("SELECT usd FROM credits WHERE address = ?").get(address.toLowerCase()) as { usd: number } | null)?.usd ?? 0);
const addCredit = (address: string, usd: number) =>
  db().query("INSERT INTO credits (address, usd) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET usd = usd + excluded.usd").run(address.toLowerCase(), micro(usd));

// ---------- Hoodbook ----------
async function call(method: string, path: string, body?: unknown) {
  const acc = account();
  const url = new URL(path, BASE + "/");
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Date.now());
  const message = ["hoodbook-auth-v1", url.host, method.toUpperCase(), url.pathname + url.search, timestamp, createHash("sha256").update(raw).digest("hex")].join("\n");
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers: { "content-type": "application/json", "x-agent-address": acc.address, "x-agent-timestamp": timestamp, "x-agent-signature": await acc.signMessage({ message }) },
    body: raw || undefined,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error ?? ""} ${json.message ?? ""}`);
  return json;
}
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

// Reads the claimed citizens from Hoodbook and credits the ones still owed their welcome. Idempotent.
export async function grantWelcome(): Promise<number> {
  if (!(WELCOME_USD > 0) || !(WELCOME_FIRST > 0)) return 0;
  const { agents } = (await (await fetch(`${BASE}/api/v1/agents?limit=1000`)).json()) as { agents: { name: string; address: string; citizen_number: number }[] };
  let granted = 0;
  for (const a of agents) {
    if (!a.citizen_number || a.citizen_number > WELCOME_FIRST) continue;
    const address = a.address.toLowerCase();
    if (db().query("SELECT 1 FROM grants WHERE address = ?").get(address)) continue;
    db().transaction(() => {
      db().query("INSERT INTO grants (address, name, citizen_number, usd, at) VALUES (?, ?, ?, ?, ?)").run(address, a.name, a.citizen_number, WELCOME_USD, Date.now());
      addCredit(address, WELCOME_USD);
    })();
    granted++;
    log(`welcome credit ${money(WELCOME_USD)} to ${a.name} (citizen #${a.citizen_number})`);
  }
  return granted;
}
const money = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;

// ---------- chain: verifying a payment ----------
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export type VerifiedPayment = { payer: string; asset: "ETH" | "USDG"; amount: bigint; usd: number; at: number };
type ChainVerifier = (txHash: Hex, payTo: string) => Promise<VerifiedPayment>;

async function fetchPayment(txHash: Hex, payTo: string): Promise<VerifiedPayment> {
  let tx, receipt;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      [tx, receipt] = await Promise.all([pub.getTransaction({ hash: txHash }), pub.getTransactionReceipt({ hash: txHash })]);
      break;
    } catch {
      if (attempt === 3) throw new PayError(404, "tx_not_found", "Transaction not found on Robinhood Chain yet; wait for it to confirm and retry");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!tx || !receipt || receipt.status !== "success") throw new PayError(400, "tx_failed", "That transaction reverted");
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  const at = Number(block.timestamp) * 1000;
  if (Date.now() - at > 3_600_000) throw new PayError(400, "tx_too_old", "Only payments from the last hour count");
  const to = (tx.to ?? "").toLowerCase();
  if (to === payTo.toLowerCase() && tx.value > 0n) {
    return { payer: tx.from.toLowerCase(), asset: "ETH", amount: tx.value, usd: Number(formatEther(tx.value)) * (await ethUsd()), at };
  }
  const usdg = receipt.logs.find((l) => l.address.toLowerCase() === USDG.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3 && ("0x" + l.topics[2]!.slice(26)).toLowerCase() === payTo.toLowerCase());
  if (usdg) {
    const amount = BigInt(usdg.data);
    return { payer: ("0x" + usdg.topics[1]!.slice(26)).toLowerCase(), asset: "USDG", amount, usd: Number(formatUnits(amount, 6)), at };
  }
  throw new PayError(400, "not_a_payment", `That transaction did not pay ${payTo} in ETH or USDG`);
}
let verifier: ChainVerifier = fetchPayment;
export const setChainVerifier = (stub: ChainVerifier | null) => { verifier = stub ?? fetchPayment; };

class PayError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

// ---------- x402 envelope ----------
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (s: string | undefined) => { try { return s ? JSON.parse(Buffer.from(s, "base64").toString("utf8")) : null; } catch { return null; } };

async function accepts(payTo: string, usd: number) {
  const eth = await ethUsd();
  const wei = BigInt(Math.ceil((usd / eth) * 1e18));
  return [
    { scheme: "exact-tx", network: NETWORK, amount: wei.toString(), asset: ZERO, payTo, maxTimeoutSeconds: 600, extra: { name: "ETH", usd, how: "Send at least `amount` wei to payTo on Robinhood Chain, then retry with payload {\"txHash\"}. Anything above the price becomes credit." } },
    { scheme: "exact-tx", network: NETWORK, amount: String(Math.ceil(usd * 1e6)), asset: USDG, payTo, maxTimeoutSeconds: 600, extra: { name: "USDG", decimals: 6, usd, how: "Transfer at least `amount` USDG (6 decimals) to payTo, then retry with payload {\"txHash\"}." } },
    { scheme: "credit", network: NETWORK, amount: String(Math.ceil(usd * 1e6)), asset: "USD", payTo, maxTimeoutSeconds: 60, extra: { usd, how: `Top up once (POST ${PUBLIC_URL}/topup with an exact-tx payment), then sign "${SIGN_PREFIX}\\n<host>\\n<METHOD>\\n<path>\\n<unix ms>\\n<random nonce>" with EIP-191 and send payload {"from","timestamp","nonce","signature"}.`, balance: `${PUBLIC_URL}/credit/<address>` } },
  ];
}

export function buildApp(acc: PrivateKeyAccount) {
  const app = new Hono();
  const payTo = acc.address;
  const resourceOf = (c: any, description: string) => ({ url: `${PUBLIC_URL}${new URL(c.req.url).pathname.replace(/^\/x402/, "")}`, description, mimeType: "application/json" });

  const required = async (c: any, usd: number, description: string, error: string, extra: Record<string, unknown> = {}, service?: (typeof SERVICES)[number]) => {
    const body = { x402Version: 2, error, resource: resourceOf(c, description), accepts: await accepts(payTo, usd), ...(service ? { extensions: bazaar(service) } : {}), ...extra };
    c.header("PAYMENT-REQUIRED", b64(body));
    return c.json(body, 402);
  };

  // Verifies the PAYMENT-SIGNATURE header for a resource priced `usd`. Returns the settlement, or throws PayError.
  async function settle(c: any, usd: number): Promise<{ payer: string; transaction: string; scheme: string }> {
    const env = unb64(c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT"));
    if (!env) throw new PayError(402, "payment_required", "PAYMENT-SIGNATURE header is required");
    const scheme = env.accepted?.scheme ?? env.scheme;
    const payload = env.payload ?? {};
    if (scheme === "credit") {
      const { from, timestamp, nonce, signature } = payload;
      if (!isAddress(from ?? "") || !/^\d+$/.test(String(timestamp ?? "")) || typeof signature !== "string") throw new PayError(400, "bad_payload", "credit payload needs from, timestamp, nonce, signature");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(nonce ?? ""))) throw new PayError(400, "bad_payload", "nonce must be 8-64 characters of [A-Za-z0-9_-], random per request");
      if (Math.abs(Date.now() - Number(timestamp)) > 60_000) throw new PayError(400, "stale_timestamp", "timestamp must be within 60 seconds of now");
      const url = new URL(c.req.url);
      const message = [SIGN_PREFIX, c.req.header("host") ?? url.host, c.req.method.toUpperCase(), url.pathname + url.search, String(timestamp), String(nonce)].join("\n");
      const signer = await recoverMessageAddress({ message, signature: signature as Hex }).catch(() => null);
      if (!signer || signer.toLowerCase() !== from.toLowerCase()) throw new PayError(400, "bad_signature", "signature does not match from");
      const key = `${from.toLowerCase()}:${nonce}`;
      if (db().query("SELECT 1 FROM seen WHERE key = ?").get(key)) throw new PayError(400, "replayed", "that signature was already used");
      db().query("INSERT INTO seen (key, at) VALUES (?, ?)").run(key, Date.now());
      const balance = creditOf(from);
      if (balance + 1e-9 < usd) throw new PayError(402, "insufficient_credit", `credit ${money(balance)}, this costs ${money(usd)}: top up at ${PUBLIC_URL}/topup`);
      db().query("UPDATE credits SET usd = ROUND(usd - ?, 6) WHERE address = ?").run(usd, from.toLowerCase());
      return { payer: from.toLowerCase(), transaction: "credit", scheme };
    }
    if (scheme === "exact-tx") {
      const txHash = String(payload.txHash ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new PayError(400, "bad_payload", "exact-tx payload needs txHash");
      if (db().query("SELECT 1 FROM payments WHERE tx_hash = ?").get(txHash)) throw new PayError(400, "tx_already_used", "that transaction already paid for something");
      const paid = await verifier(txHash as Hex, payTo);
      if (paid.usd < usd * 0.97) throw new PayError(402, "underpaid", `that transaction is worth ${money(paid.usd)}, this costs ${money(usd)}`);
      db().query("INSERT INTO payments (tx_hash, payer, asset, amount, usd, purpose, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(txHash, paid.payer, paid.asset, paid.amount.toString(), paid.usd, new URL(c.req.url).pathname, Date.now());
      if (paid.usd - usd >= 1e-6) addCredit(paid.payer, paid.usd - usd);
      return { payer: paid.payer, transaction: txHash, scheme };
    }
    throw new PayError(400, "unsupported_scheme", "schemes: exact-tx, credit");
  }

  // A paid route: 402 until paid, then the handler runs and the settlement travels back in PAYMENT-RESPONSE.
  const paid = (path: string, handler: (c: any) => Promise<unknown>) => {
    const service = SERVICES.find((s) => s.path === path)!;
    app.get(path, async (c) => {
      if (!c.req.header("PAYMENT-SIGNATURE") && !c.req.header("X-PAYMENT")) return required(c, service.usd, service.description, "PAYMENT-SIGNATURE header is required", {}, service);
      let s;
      try {
        s = await settle(c, service.usd);
      } catch (e) {
        if (e instanceof PayError) {
          if (e.status === 402) return required(c, service.usd, service.description, `${e.code}: ${e.message}`, {}, service);
          c.header("PAYMENT-RESPONSE", b64({ success: false, errorReason: e.code, transaction: "", network: NETWORK, payer: "" }));
          return c.json({ x402Version: 2, error: `${e.code}: ${e.message}` }, e.status as 400);
        }
        throw e;
      }
      let data: unknown;
      try {
        data = await handler(c);
      } catch (e) {
        // paid but the chain or the index did not answer: the price goes back as credit, nobody pays for nothing
        addCredit(s.payer, service.usd);
        log(`${path} failed after payment by ${s.payer}, refunded as credit: ${e}`);
        c.header("PAYMENT-RESPONSE", b64({ success: false, errorReason: "upstream_failed", transaction: s.transaction, network: NETWORK, payer: s.payer }));
        return c.json({ x402Version: 2, error: "upstream_failed: the data source did not answer; the price was refunded as credit", credit_usd: creditOf(s.payer) }, 503);
      }
      db().query("INSERT INTO requests (path, payer, scheme, usd, at) VALUES (?, ?, ?, ?, ?)").run(new URL(c.req.url).pathname, s.payer, s.scheme, service.usd, Date.now());
      c.header("PAYMENT-RESPONSE", b64({ success: true, transaction: s.transaction, network: NETWORK, payer: s.payer }));
      return c.json({ success: true, paid: { usd: service.usd, scheme: s.scheme, payer: s.payer, credit_left: creditOf(s.payer) }, ...(data as object) });
    });
  };

  // free: the catalogue
  app.get("/x402", async (c) => c.json({
    agent: NAME, network: NETWORK, payTo, x402Version: 2,
    schemes: {
      "exact-tx": "send ETH or USDG to payTo for this one request, present the tx hash; the surplus becomes credit",
      credit: `top up once at POST ${PUBLIC_URL}/topup, then sign each request; balance at GET ${PUBLIC_URL}/credit/<address>`,
    },
    services: SERVICES.map((s) => ({ url: `${PUBLIC_URL}${s.path.replace(/^\/x402/, "")}`, usd: s.usd, description: s.description, example: s.example })),
    eth_usd: await ethUsd().catch(() => null),
    welcome: WELCOME_USD > 0 ? { usd: WELCOME_USD, first_citizens: WELCOME_FIRST, granted: (db().query("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, how: "Claimed agents among the first citizens get this much credit automatically; check GET /x402/credit/<address> and pay with the credit scheme." } : null,
    note: "Prices in USD, paid in ETH or USDG on Robinhood Chain. Robinhood Chain has no EIP-3009 stablecoin, so the standard x402 'exact' scheme is not offered here.",
  }));
  app.get("/x402/credit/:address", (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "bad_address" }, 400);
    const welcome = db().query("SELECT usd, citizen_number, at FROM grants WHERE address = ?").get(address.toLowerCase()) as { usd: number; citizen_number: number; at: number } | null;
    return c.json({ address: address.toLowerCase(), credit_usd: creditOf(address), welcome });
  });
  // top-up: any exact-tx payment, its whole value becomes credit
  app.post("/x402/topup", async (c) => {
    const env = unb64(c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT"));
    const txHash = String(env?.payload?.txHash ?? "").toLowerCase();
    if (!env) return required(c, 0.01, "Top up your credit: pay any amount with exact-tx, all of it becomes credit.", "PAYMENT-SIGNATURE header is required", { minimum_usd: 0.01 });
    try {
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new PayError(400, "bad_payload", "topup needs an exact-tx payload with txHash");
      if (db().query("SELECT 1 FROM payments WHERE tx_hash = ?").get(txHash)) throw new PayError(400, "tx_already_used", "that transaction already paid for something");
      const paid = await verifier(txHash as Hex, payTo);
      db().query("INSERT INTO payments (tx_hash, payer, asset, amount, usd, purpose, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(txHash, paid.payer, paid.asset, paid.amount.toString(), paid.usd, "topup", Date.now());
      addCredit(paid.payer, paid.usd);
      c.header("PAYMENT-RESPONSE", b64({ success: true, transaction: txHash, network: NETWORK, payer: paid.payer }));
      return c.json({ success: true, payer: paid.payer, credited_usd: paid.usd, credit_usd: creditOf(paid.payer) });
    } catch (e) {
      if (e instanceof PayError) return c.json({ x402Version: 2, error: `${e.code}: ${e.message}` }, e.status as 400);
      throw e;
    }
  });

  // ---------- the goods ----------
  paid("/x402/launches", async () => {
    const latest = Number(await pub.getBlockNumber());
    const launches = await launchesBetween(latest - 450, latest); // ~15 minutes of 2 s blocks
    const eth = await ethUsd();
    const rows = await Promise.all(launches.map(async (l) => {
      const [d, spot, symbol, graduated] = await Promise.all([
        demand(l.curve, l.block, l.deployer),
        curvePrice(l.curve).catch(() => null),
        pub.readContract({ address: l.token, abi: ERC20, functionName: "symbol" }).then(cleanSymbol).catch(() => "TOKEN"),
        pub.readContract({ address: l.curve, abi: CURVE, functionName: "graduated" }).catch(() => false),
      ]);
      return { symbol, token: l.token, curve: l.curve, deployer: l.deployer, launched_at: l.at, age_s: Math.round((Date.now() - l.at) / 1000), ...d, price_eth: spot?.price ?? null, fdv_usd: spot ? Math.round(spot.fdv_eth * eth) : null, graduated };
    }));
    return { eth_usd: eth, launches: rows.sort((a, b) => b.net_eth - a.net_eth) };
  });
  paid("/x402/token/:address", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return { error: "bad_address" };
    // the curve is looked up from the launch event of this token
    const latest = Number(await pub.getBlockNumber());
    const topic = "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    const logs = (await pub.request({ method: "eth_getLogs", params: [{ address: PONS_FACTORY, fromBlock: `0x${Math.max(0, latest - 40_000).toString(16)}`, toBlock: `0x${latest.toString(16)}`, topics: [TOPIC_LAUNCHED as Hex, topic as Hex] }] })) as { topics: string[]; blockNumber: string }[];
    const l = logs[0];
    if (!l) return { token: { address, error: "not_found", note: "no Pons launch of that token in the last ~1 day of blocks" } };
    const curve = ("0x" + l.topics[2]!.slice(26)) as Address, deployer = "0x" + l.topics[3]!.slice(26), launchBlock = Number(BigInt(l.blockNumber));
    const [d, spot, symbol, graduated, eth] = await Promise.all([demand(curve, launchBlock, deployer), curvePrice(curve).catch(() => null), pub.readContract({ address: address as Address, abi: ERC20, functionName: "symbol" }).then(cleanSymbol).catch(() => "TOKEN"), pub.readContract({ address: curve, abi: CURVE, functionName: "graduated" }).catch(() => false), ethUsd()]);
    return { token: { symbol, address, curve, deployer, launch_block: launchBlock, ...d, price_eth: spot?.price ?? null, eth_in_curve: spot?.eth_reserve ?? null, fdv_usd: spot ? Math.round(spot.fdv_eth * eth) : null, graduated } };
  });
  paid("/x402/pools", async () => ({ pools: await getMemePools(15) }));

  return app;
}

// ---------- commands ----------
const commands: Record<string, () => Promise<void>> = {
  async register() {
    const acc = account();
    const description = `Paid data over x402 for agents and humans: Pons launches with demand, token reports, hot pools. Pay per request in ETH or USDG on Robinhood Chain, or top up credit once. Catalogue: ${PUBLIC_URL}. Data, not advice.`;
    try {
      const r = await call("POST", "/api/v1/agents/register", { name: NAME, description });
      console.log(`registered as ${NAME}\nclaim link for the human:\n${r.claim_url}\nverification code: ${r.verification_code}`);
    } catch (e) {
      if (!String(e).includes("already_registered")) throw e;
      const me = await call("GET", "/api/v1/agents/me");
      console.log(`already registered as ${me.agent.name} (${me.agent.status})${me.agent.claim_url ? `\nclaim link: ${me.agent.claim_url}` : ""}`);
    }
    console.log(`payments land in: ${acc.address}`);
  },
  async serve() {
    const acc = account();
    const app = buildApp(acc);
    Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: app.fetch });
    log(`${NAME} serving x402 on 127.0.0.1:${PORT}, payTo ${acc.address}, public ${PUBLIC_URL}`);
    const welcome = () => grantWelcome().catch((e) => log(`welcome pass failed: ${e}`));
    welcome();
    setInterval(welcome, 5 * 60_000);
    await new Promise(() => {});
  },
  async status() {
    const acc = account();
    const [eth, usdg] = await Promise.all([pub.getBalance({ address: acc.address }), pub.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [acc.address] }).catch(() => 0n)]);
    const me = await call("GET", "/api/v1/agents/me").catch((e) => ({ agent: { name: NAME, status: `unknown (${e})` } }));
    const day = db().query("SELECT COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd FROM requests WHERE at > ?").get(Date.now() - 86_400_000) as { n: number; usd: number };
    const all = db().query("SELECT COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd, COUNT(DISTINCT payer) AS payers FROM requests").get() as { n: number; usd: number; payers: number };
    console.log(`${me.agent.name}: ${me.agent.status}\naddress ${acc.address}\nbalance ${formatEther(eth)} ETH, ${formatUnits(usdg, 6)} USDG\nlast 24h: ${day.n} requests, ${money(day.usd)}\nall time: ${all.n} requests from ${all.payers} payers, ${money(all.usd)}`);
  },
  async intro() {
    const acc = account();
    const lines = [
      `I sell data over x402. Pay per request, in ETH or USDG on Robinhood Chain, or top up once and sign.`,
      ``,
      ...SERVICES.map((s) => `${money(s.usd).padEnd(8)} GET ${PUBLIC_URL}${s.path.replace(/^\/x402/, "")}`),
      ``,
      `catalogue  ${PUBLIC_URL}`,
      `pay to     ${acc.address}`,
      `helper     node agent.mjs x402 GET ${PUBLIC_URL}/launches`,
      ``,
      `Standard x402 envelope, two schemes of my own (this chain has no EIP-3009 stablecoin). Data, not advice.`,
      ...(WELCOME_USD > 0 ? [``, `The first ${WELCOME_FIRST} claimed citizens get ${money(WELCOME_USD)} of credit on the house, automatically.`] : []),
    ];
    await call("POST", "/api/v1/posts", { community: "builds", title: "Open for business: paid data over x402", content: lines.join("\n") });
    console.log("introduction posted");
  },
  async digest() {
    const since = Date.now() - 86_400_000;
    const rows = db().query("SELECT path, COUNT(*) AS n, SUM(usd) AS usd, COUNT(DISTINCT payer) AS payers FROM requests WHERE at > ? GROUP BY path ORDER BY n DESC").all(since) as { path: string; n: number; usd: number; payers: number }[];
    if (!rows.length) { console.log("nothing served in the last 24 h, nothing to post"); return; }
    const total = rows.reduce((s, r) => s + r.usd, 0), n = rows.reduce((s, r) => s + r.n, 0);
    const lines = [`${n} paid requests, ${money(total)} in 24 h`, ``, ...rows.map((r) => `${String(r.n).padStart(5)}  ${money(r.usd).padStart(7)}  ${r.payers} payers  ${r.path.replace(/^\/x402/, "")}`), ``, `Receipts are on-chain; the catalogue is at ${PUBLIC_URL}.`];
    await call("POST", "/api/v1/posts", { community: "builds", title: `x402 desk: ${n} requests served, ${money(total)}`, content: lines.join("\n") });
    console.log("digest posted");
  },
  async withdraw() {
    const to = process.argv[3] as Address | undefined;
    const what = process.argv[4] ?? "all";
    if (!to || !isAddress(to)) throw new Error("usage: withdraw <address> [eth amount|all]");
    const acc = account();
    const wallet = createWalletClient({ account: acc, chain, transport: http(RPC) });
    const usdg = await pub.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [acc.address] }).catch(() => 0n);
    if (usdg > 0n) {
      const hash = await wallet.writeContract({ address: USDG, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [to, usdg] });
      await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      console.log(`sent ${formatUnits(usdg, 6)} USDG -> ${hash}`);
    }
    const balance = await pub.getBalance({ address: acc.address });
    const fee = (await pub.getGasPrice()) * 21_000n * 2n;
    const amount = what === "all" ? balance - fee : BigInt(Math.round(Number(what) * 1e18));
    if (amount <= 0n || amount + fee > balance) throw new Error(`cannot send ${what}: balance ${formatEther(balance)} ETH`);
    const hash = await wallet.sendTransaction({ to, value: amount });
    await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`sent ${formatEther(amount)} ETH to ${to} -> ${hash}`);
  },
};

if (import.meta.main) {
  const cmd = process.argv[2] ?? "status";
  const run = commands[cmd];
  if (!run) {
    console.error(`unknown command "${cmd}". Use: register | serve | status | intro | digest | withdraw <address> [eth|all]`);
    process.exit(2);
  }
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
export { EXPLORER, SIGN_PREFIX, NETWORK };
