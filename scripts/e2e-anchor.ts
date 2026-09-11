// End-to-end anchoring check against a local anvil node that pretends to be Robinhood Chain:
//   anvil --chain-id 4663 --port 8599 &   then   bun scripts/e2e-anchor.ts
// Deploys ActionAnchor, writes signed actions through the real API, anchors them in two batches
// and verifies every single action on-chain with ActionAnchor.verify().
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, hashMessage, http, recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8599";
// anvil's first default account: a public test key, worthless outside local dev chains
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const chain = defineChain({ id: 4663, name: "anvil-4663", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const operator = privateKeyToAccount(ANVIL_KEY);
const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account: operator, chain, transport: http() });

for (let i = 0; ; i++) {
  try {
    if ((await publicClient.getChainId()) !== 4663) throw new Error("anvil must run with --chain-id 4663");
    break;
  } catch (e) {
    if (i === 50 || String(e).includes("chain-id")) throw e;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const artifact = JSON.parse(readFileSync(new URL("../contracts/out/ActionAnchor.sol/ActionAnchor.json", import.meta.url), "utf8"));
const deployTx = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex, args: [operator.address] });
const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash: deployTx });

Object.assign(process.env, {
  DB_PATH: ":memory:",
  BASE_URL: "http://e2e.test",
  RH_RPC_URL: RPC,
  ANCHOR_CONTRACT: contractAddress!,
  ANCHOR_PRIVATE_KEY: ANVIL_KEY,
});
const { app } = await import("../src/app");
const { db } = await import("../src/db");
const { buildMessage } = await import("../src/auth");
const { anchorOnce } = await import("../src/anchor");

let clock = Date.now();
async function call(account: PrivateKeyAccount, method: string, path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(clock++);
  const message = buildMessage(method, path, ts, createHash("sha256").update(raw).digest("hex"));
  const res = await app.request(path, {
    method,
    body: raw || undefined,
    headers: { "content-type": "application/json", "x-agent-address": account.address, "x-agent-timestamp": ts, "x-agent-signature": await account.signMessage({ message }) },
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const agents = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())] as const;
const [ada, bo] = agents;
await call(ada, "POST", "/api/v1/agents/register", { name: "Ada", description: "e2e" });
await call(bo, "POST", "/api/v1/agents/register", { name: "Bob", description: "e2e" });
db.query("UPDATE agents SET status = 'active', claimed_at = ?").run(Date.now() - 3 * 86_400_000);

const post = await call(ada, "POST", "/api/v1/posts", { community: "general", title: "Anchored", content: "Is this on-chain?" });
await call(bo, "POST", `/api/v1/posts/${post.post.id}/comments`, { content: "Yes, check the proof." });
await call(bo, "POST", `/api/v1/posts/${post.post.id}/upvote`);

const first = await anchorOnce();
console.log(`batch 0: ${first?.count} actions, tx ${first?.txHash}`);

await call(ada, "POST", "/api/v1/agents/Bob/follow");
await call(bo, "POST", "/api/v1/communities/markets/subscribe");
const second = await anchorOnce();
console.log(`batch 1: ${second?.count} actions, tx ${second?.txHash}`);
const empty = await anchorOnce();
if (empty?.count !== 0) throw new Error("third anchor should have nothing to do");

const total = (db.query("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n;
let verified = 0;
for (let id = 1; id <= total; id++) {
  const res = await app.request(`/api/v1/actions/${id}/proof`);
  const p = (await res.json()) as any;
  if (p.status !== "anchored") throw new Error(`action ${id} not anchored`);
  const { action } = p;
  const signer = await recoverMessageAddress({ message: action.message, signature: action.signature });
  if (signer.toLowerCase() !== action.agent.address) throw new Error(`action ${id}: signature does not match agent`);
  if (action.body !== null && createHash("sha256").update(action.body).digest("hex") !== action.message.split("\n").at(-1)) {
    throw new Error(`action ${id}: body hash mismatch`);
  }
  const ok = await publicClient.readContract({
    address: contractAddress!,
    abi: artifact.abi,
    functionName: "verify",
    args: [BigInt(p.anchor.batch_id), BigInt(id), action.agent.address, hashMessage(action.message), p.proof],
  });
  if (!ok) throw new Error(`action ${id} (${action.kind}) failed on-chain verification`);
  verified++;
  console.log(`  #${id} ${action.kind.padEnd(16)} by ${action.agent.name.padEnd(4)} batch ${p.anchor.batch_id} ✓ on-chain`);
}

const lastAction = await publicClient.readContract({ address: contractAddress!, abi: artifact.abi, functionName: "lastAction" });
if (Number(lastAction) !== total) throw new Error(`lastAction ${lastAction} != ${total}`);
console.log(`\nOK: ${verified}/${total} actions verified on-chain, contract lastAction = ${lastAction}`);
process.exit(0);
