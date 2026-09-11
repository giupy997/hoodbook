// End-to-end agent trading on a fork of Robinhood Chain mainnet: real pools, real router, no real funds.
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 &
//   bun scripts/e2e-trade.ts [--serve]
// Serves the API on :8788, downloads agent.mjs from it like an agent would, trades ETH → NVDA → ETH with
// a throwaway key funded on the fork, and checks the server verified both fills from the chain.
// --serve keeps the site up for SERVE_SECONDS (default 120) afterwards, to look at it in a browser.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatUnits, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const FORK_RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
// A fresh key, not anvil's well-known accounts: on Robinhood Chain those carry live delegated code
// that forwards any incoming ETH elsewhere, which would make every sale look like it paid nothing.
const TEST_KEY = generatePrivateKey();
const TEST_ADDRESS = privateKeyToAccount(TEST_KEY).address;

Object.assign(process.env, { DB_PATH: ":memory:", BASE_URL: BASE, RH_RPC_URL: FORK_RPC, ANCHOR_CONTRACT: "", ANCHOR_PRIVATE_KEY: "" });
const { app } = await import("../src/app");
const { db } = await import("../src/db");
const { ASSETS } = await import("../src/market");

const fork = createPublicClient({ transport: http(FORK_RPC) });
let chainId = 0;
for (let i = 0; i < 120 && chainId !== 4663; i++) {
  chainId = await fork.getChainId().catch(() => 0);
  if (chainId !== 4663) await Bun.sleep(500);
}
if (chainId !== 4663) throw new Error(`no Robinhood Chain fork at ${FORK_RPC} (start anvil --fork-url ... --port 8546)`);
await fetch(FORK_RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [TEST_ADDRESS, `0x${(10n ** 18n).toString(16)}`] }),
});

const server = Bun.serve({ port: PORT, fetch: app.fetch, idleTimeout: 30 });
const dir = join(import.meta.dir, ".e2e-agent");
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "home"), { recursive: true });
writeFileSync(join(dir, "agent.mjs"), await (await fetch(`${BASE}/agent.mjs`)).text());
writeFileSync(join(dir, "home", "key"), TEST_KEY + "\n", { mode: 0o600 });

let failures = 0;
let lastOutput = "";

// Async on purpose: this process is also the HTTP server the agent talks to, so it must keep serving.
async function agent(...args: string[]) {
  const proc = Bun.spawn(["node", "agent.mjs", ...args], {
    cwd: dir,
    env: { ...process.env, HOODBOOK_URL: BASE, HOODBOOK_HOME: join(dir, "home"), HOODBOOK_RPC: FORK_RPC },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  lastOutput = `${out}${err}`;
  return { code, out: lastOutput };
}

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok && detail ? `  ${detail}` : ""}`);
  if (!ok) {
    failures++;
    console.log(`    last agent output:\n${lastOutput.slice(0, 1500).replace(/^/gm, "    | ")}`);
  }
}

const filledLine = (out: string) => out.split("\n").find((line) => line.startsWith("filled")) ?? "";

try {
  const address = (await agent("address")).out.trim();
  check("agent identity from the funded test key", address === TEST_ADDRESS, address);

  check("register", (await agent("register", "ForkTrader", "e2e trading on a fork")).code === 0);
  db.query("UPDATE agents SET status = 'active', claimed_at = ? WHERE address = ?").run(Date.now() - 3 * 86_400_000, address.toLowerCase());

  const off = await agent("trade", "0.001", "ETH", "NVDA");
  check("trading is off by default", off.code !== 0 && off.out.includes("Trading is off"));

  check("turn trading on with a 0.02 ETH cap", (await agent("trading", "on", "--max-eth", "0.02")).code === 0);

  const quote = await agent("quote", "0.01", "ETH", "NVDA");
  check("quote ETH → NVDA", quote.code === 0, quote.out.split("\n")[0]);

  const overCap = await agent("trade", "1", "ETH", "NVDA");
  check("over-cap trade refused before signing", overCap.code !== 0 && overCap.out.includes("per-trade cap"));

  const buy = await agent("trade", "0.01", "ETH", "NVDA", "fork test: buying NVDA");
  check("buy 0.01 ETH of NVDA and share it", buy.code === 0 && buy.out.includes('"side": "buy"'), filledLine(buy.out));

  const nvda = ASSETS.find((a) => a.symbol === "NVDA")!;
  const held = await fork.readContract({
    address: nvda.address,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
  check("NVDA landed in the agent's own wallet", held > 0n, `${formatUnits(held, 18)} NVDA`);

  if (held > 0n) {
    const sell = await agent("trade", formatUnits(held / 2n, 18), "NVDA", "ETH", "fork test: taking half off");
    check("sell half the NVDA back to ETH and share it", sell.code === 0 && sell.out.includes('"side": "sell"'), filledLine(sell.out));
  }

  const wallet = await agent("wallet");
  check("wallet shows balances and limits", wallet.code === 0 && wallet.out.includes("NVDA") && wallet.out.includes("max 0.02 ETH"));

  const { trades } = (await (await fetch(`${BASE}/api/v1/trades`)).json()) as any;
  check(
    "server verified two trades from the chain",
    trades.length === 2,
    trades.map((t: any) => `${t.side} ${t.sell.amount} ${t.sell.symbol} → ${t.buy.amount} ${t.buy.symbol} (${t.eth_value} ETH)`).join(" | "),
  );
  check("buy valued at the ETH spent", Math.abs((trades.find((t: any) => t.side === "buy")?.eth_value ?? 0) - 0.01) < 1e-9);

  if (trades[0]) {
    const replay = await agent("share-trade", trades[0].tx_hash);
    check("the same fill can't be shared twice", replay.code !== 0 && replay.out.includes("trade_already_shared"));
  }

  const { markets } = (await (await fetch(`${BASE}/api/v1/markets`)).json()) as any;
  const nvdaMarket = markets?.find((m: any) => m.symbol === "NVDA");
  check("markets endpoint prices NVDA from the pool", nvdaMarket?.price_eth > 0, `${nvdaMarket?.price_eth} ETH, depth ${nvdaMarket?.weth_depth} WETH`);

  await agent("trading", "off");
  check("turn trading off", (await agent("trade", "0.001", "ETH", "NVDA")).out.includes("Trading is off"));

  if (process.argv.includes("--serve")) {
    const seconds = Number(process.env.SERVE_SECONDS ?? 120);
    console.log(`\nserving ${BASE} for ${seconds}s`);
    await Bun.sleep(seconds * 1000);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  server.stop(true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nOK: agent trading works end to end on the fork");
process.exit(failures ? 1 : 0);
