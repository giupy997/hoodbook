import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.X402AGENT_HOME = mkdtempSync(join(tmpdir(), "x402-"));
process.env.X402_DB = ":memory:";
process.env.X402_PUBLIC_URL = "https://api.test/x402";
process.env.HOODBOOK_URL = "https://api.test";
process.env.ETH_USD_FIXED = "2500";

const { buildApp, setChainVerifier, SERVICES, SIGN_PREFIX } = await import("../scripts/x402agent");

const desk = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());
const app = buildApp(desk);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (s: string | null) => JSON.parse(Buffer.from(s ?? "", "base64").toString("utf8"));
const get = (path: string, headers: Record<string, string> = {}) => app.request(`https://api.test${path}`, { headers: { host: "api.test", ...headers } });
const credit = async (address: string) => ((await (await get(`/x402/credit/${address}`)).json()) as any).credit_usd as number;
const post = (path: string, headers: Record<string, string> = {}) => app.request(`https://api.test${path}`, { method: "POST", headers: { host: "api.test", ...headers } });

// the ETH price feed is external: the app only needs it for quoting, so a failing feed shows up as a 402 without a quote
async function creditHeader(method: string, path: string, who = payer, timestamp = Date.now(), nonce = Math.random().toString(36).slice(2, 14)) {
  const message = [SIGN_PREFIX, "api.test", method, path, String(timestamp), nonce].join("\n");
  const signature = await who.signMessage({ message });
  return b64({ x402Version: 2, accepted: { scheme: "credit" }, payload: { from: who.address, timestamp, nonce, signature } });
}

describe("x402 desk", () => {
  test("the catalogue is free and lists every service with a price", async () => {
    const res = await get("/x402");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.payTo).toBe(desk.address);
    expect(json.network).toBe("eip155:4663");
    expect(json.services.length).toBe(SERVICES.length);
    expect(json.services[0].url).toBe("https://api.test/x402/launches");
  });

  test("a paid route answers 402 with the x402 envelope in the header and the body", async () => {
    const res = await get("/x402/pools");
    expect(res.status).toBe(402);
    const header = unb64(res.headers.get("PAYMENT-REQUIRED"));
    const body = (await res.json()) as any;
    expect(header.x402Version).toBe(2);
    expect(header.resource.url).toBe("https://api.test/x402/pools");
    expect(header.accepts.map((a: any) => a.scheme).sort()).toEqual(["credit", "exact-tx", "exact-tx"]);
    expect(header.accepts.every((a: any) => a.network === "eip155:4663" && a.payTo === desk.address)).toBe(true);
    expect(body.accepts.length).toBe(3);
  });

  test("an unknown scheme is a 400, a bad credit signature too", async () => {
    const bad = await get("/x402/pools", { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted: { scheme: "exact" }, payload: {} }) });
    expect(bad.status).toBe(400);
    expect(unb64(bad.headers.get("PAYMENT-RESPONSE")).success).toBe(false);
    const forged = await get("/x402/pools", { "PAYMENT-SIGNATURE": await creditHeader("GET", "/x402/pools", privateKeyToAccount(generatePrivateKey())).then((h) => { const o = unb64(h); o.payload.from = payer.address; return b64(o); }) });
    expect(((await forged.json()) as any).error).toContain("bad_signature");
  });

  test("credit: no balance is a 402 that says so; a top-up by exact-tx credits the payer", async () => {
    const broke = await get("/x402/pools", { "PAYMENT-SIGNATURE": await creditHeader("GET", "/x402/pools") });
    expect(broke.status).toBe(402);
    expect(((await broke.json()) as any).error).toContain("insufficient_credit");

    // the chain is stubbed: this "transaction" paid the desk 0.5 USD in ETH
    const tx = ("0x" + "ab".repeat(32)) as `0x${string}`;
    setChainVerifier(async (hash, payTo) => {
      expect(hash).toBe(tx);
      expect(payTo).toBe(desk.address);
      return { payer: payer.address.toLowerCase(), asset: "ETH", amount: 200_000_000_000_000n, usd: 0.5, at: Date.now() };
    });
    const topup = await post("/x402/topup", { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted: { scheme: "exact-tx" }, payload: { txHash: tx } }) });
    expect(topup.status).toBe(200);
    expect(((await topup.json()) as any).credit_usd).toBe(0.5);
    expect(unb64(topup.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, transaction: tx, payer: payer.address.toLowerCase() });
    // the same transaction cannot be spent twice
    const again = await post("/x402/topup", { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted: { scheme: "exact-tx" }, payload: { txHash: tx } }) });
    expect(again.status).toBe(400);
    expect(await credit(payer.address)).toBe(0.5);
  });

  test("exact-tx on a resource: the surplus above the price becomes credit, a replayed credit signature is refused", async () => {
    const tx = ("0x" + "cd".repeat(32)) as `0x${string}`;
    setChainVerifier(async () => ({ payer: payer.address.toLowerCase(), asset: "USDG", amount: 30_000n, usd: 0.03, at: Date.now() }));
    // /x402/pools costs 0.01: the chain read behind it is external, so the settlement is what we check
    const res = await get("/x402/pools", { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted: { scheme: "exact-tx" }, payload: { txHash: tx } }) });
    expect(unb64(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, transaction: tx });
    expect(await credit(payer.address)).toBeCloseTo(0.52, 6);

    const stamp = Date.now();
    const header = await creditHeader("GET", "/x402/pools", payer, stamp);
    const first = await get("/x402/pools", { "PAYMENT-SIGNATURE": header });
    expect(unb64(first.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, transaction: "credit" });
    expect(await credit(payer.address)).toBeCloseTo(0.51, 6);
    const replay = await get("/x402/pools", { "PAYMENT-SIGNATURE": header });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toContain("replayed");
    // a stale timestamp is refused before any balance is touched
    const stale = await get("/x402/pools", { "PAYMENT-SIGNATURE": await creditHeader("GET", "/x402/pools", payer, Date.now() - 5 * 60_000) });
    expect(((await stale.json()) as any).error).toContain("stale_timestamp");
  });
});
