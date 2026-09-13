// Turning the anchorer on, without foundry on the server and without a key ever leaving it.
//
//   bun scripts/anchor-setup.ts key      make the anchorer key if .env has none, print only its address (fund it)
//   bun scripts/anchor-setup.ts deploy   deploy ActionAnchor with that key, write ANCHOR_CONTRACT into .env
//   bun scripts/anchor-setup.ts status   anchorer address, balance, contract, batches on-chain
//
// Run as the app user on the server, from /opt/hoodbook. .env stays chmod 600; nothing secret is printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV_FILE = process.env.ENV_FILE || ".env";
const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
// Sets one variable in .env in place: replaces the line if present, appends otherwise. Never prints values.
function setEnv(name: string, value: string) {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${name}=.*$`, "m");
  const next = re.test(text) ? text.replace(re, `${name}=${value}`) : text.replace(/\n?$/, "\n") + `${name}=${value}\n`;
  writeFileSync(ENV_FILE, next, { mode: 0o600 });
}

const commands: Record<string, () => Promise<void>> = {
  async key() {
    const env = readEnv();
    let key = env.ANCHOR_PRIVATE_KEY;
    if (!key) {
      key = generatePrivateKey();
      setEnv("ANCHOR_PRIVATE_KEY", key);
      console.log(`anchorer key created in ${ENV_FILE}`);
    } else console.log(`anchorer key already in ${ENV_FILE}`);
    const address = privateKeyToAccount(key as Hex).address;
    console.log(`anchorer address (fund it with a little ETH on Robinhood Chain): ${address}`);
    console.log(`balance now: ${formatEther(await pub.getBalance({ address }))} ETH`);
  },
  async deploy() {
    const env = readEnv();
    if (!env.ANCHOR_PRIVATE_KEY) throw new Error("no ANCHOR_PRIVATE_KEY in .env: run `key` first");
    if (env.ANCHOR_CONTRACT) throw new Error(`ANCHOR_CONTRACT is already set (${env.ANCHOR_CONTRACT}); remove it from .env to deploy again`);
    const account = privateKeyToAccount(env.ANCHOR_PRIVATE_KEY as Hex);
    const balance = await pub.getBalance({ address: account.address });
    if (balance === 0n) throw new Error(`anchorer ${account.address} has no ETH yet`);
    const artifact = JSON.parse(readFileSync(new URL("../contracts/artifacts/ActionAnchor.json", import.meta.url), "utf8")) as { abi: any; bytecode: Hex };
    const wallet = createWalletClient({ account, chain, transport: http(RPC) });
    console.log(`deploying ActionAnchor from ${account.address} (balance ${formatEther(balance)} ETH)…`);
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address] });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deployment failed: ${hash}`);
    setEnv("ANCHOR_CONTRACT", receipt.contractAddress);
    console.log(`ActionAnchor deployed at ${receipt.contractAddress}\ntx ${hash}\nANCHOR_CONTRACT written to ${ENV_FILE}; restart the service to start anchoring`);
  },
  async status() {
    const env = readEnv();
    if (!env.ANCHOR_PRIVATE_KEY) { console.log("no anchorer key yet"); return; }
    const address = privateKeyToAccount(env.ANCHOR_PRIVATE_KEY as Hex).address;
    console.log(`anchorer ${address}, balance ${formatEther(await pub.getBalance({ address }))} ETH`);
    if (!env.ANCHOR_CONTRACT) { console.log("no contract yet"); return; }
    const abi = parseAbi(["function lastAction() view returns (uint256)", "function batchCount() view returns (uint256)", "function anchorer() view returns (address)"]);
    const [last, batches, anchorer] = await Promise.all(["lastAction", "batchCount", "anchorer"].map((fn) => pub.readContract({ address: env.ANCHOR_CONTRACT as Hex, abi, functionName: fn as any })));
    console.log(`contract ${env.ANCHOR_CONTRACT}: ${batches} batches, actions anchored up to #${last}, anchorer on-chain ${anchorer}${String(anchorer).toLowerCase() === address.toLowerCase() ? "" : " (MISMATCH)"}`);
  },
};

const cmd = process.argv[2] ?? "status";
const run = commands[cmd];
if (!run) {
  console.error("unknown command. Use: key | deploy | status");
  process.exit(2);
}
run().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
