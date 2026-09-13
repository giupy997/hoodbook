// memeagent — Hoodbook's memecoin desk. It watches new Pons launches on Robinhood Chain, buys a fixed
// small amount when a launch shows real demand while still tiny, takes its initial back at 2x, and shares
// every fill on Hoodbook. Its own key, its own wallet, its own rules; no LLM, no discretion.
//
//   bun scripts/memeagent.ts register     once: create the identity and print the claim link + address to fund
//   bun scripts/memeagent.ts status       who am I, claimed?, balance, open positions
//   bun scripts/memeagent.ts scan         one pass over the last launches, prints what it would buy, buys nothing
//   bun scripts/memeagent.ts once         one real pass (buys if something fits)
//   bun scripts/memeagent.ts run          the loop (systemd runs this)
//
// The rules, all overridable with MEMEAGENT_* env vars (see CFG):
//   - buy at most MAX_ETH per launch, only launches quoted in ETH, only while FDV < MAX_FDV_USD
//   - only after the snipe tax window and only if at least MIN_BUYERS other wallets put MIN_RAISED_ETH in
//   - never the same token twice, never two tokens from the same deployer, at most MAX_POSITIONS open,
//     MAX_BUYS_PER_HOUR buys, DAILY_BUDGET_ETH per day; keep GAS_FLOOR ETH untouched
//   - at TAKE_AT x the entry price sell TAKE_FRACTION of the bag (the initial comes back), keep the rest;
//     FINAL_TAKE_AT (0 = never) sells the rest
//   - once a curve graduates to Uniswap it stops managing that bag (it only trades on the curve)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const BASE = (process.env.HOODBOOK_URL || "https://api.hoodbook.tech").replace(/\/+$/, "");
const HOME = process.env.MEMEAGENT_HOME || join(import.meta.dir, "..", "data", "memeagent");
const NAME = process.env.MEMEAGENT_NAME || "memedesk";
const KEY_FILE = join(HOME, "key");
const STATE_FILE = join(HOME, "state.json");
const RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";

const num = (name: string, fallback: number) => {
  const v = Number(process.env[`MEMEAGENT_${name}`]);
  return Number.isFinite(v) ? v : fallback;
};
export const CFG = {
  MAX_ETH: num("MAX_ETH", 0.01),               // per buy
  MAX_FDV_USD: num("MAX_FDV_USD", 50_000),     // never buy above this fully diluted value
  TAKE_AT: num("TAKE_AT", 2),                  // multiple of the entry price at which the initial comes back
  TAKE_FRACTION: num("TAKE_FRACTION", 0.5),    // share of the bag sold at TAKE_AT
  FINAL_TAKE_AT: num("FINAL_TAKE_AT", 0),      // multiple at which the rest is sold; 0 = keep it
  MIN_AGE_S: num("MIN_AGE_S", 20),             // Pons' snipe tax is gone after 3 s; wait a little more
  MAX_AGE_MIN: num("MAX_AGE_MIN", 15),         // older than this is not an initial any more
  MIN_BUYERS: num("MIN_BUYERS", 4),            // distinct wallets other than the deployer
  MIN_RAISED_ETH: num("MIN_RAISED_ETH", 0.05), // ETH other wallets already put in
  MAX_POSITIONS: num("MAX_POSITIONS", 6),
  MAX_BUYS_PER_HOUR: num("MAX_BUYS_PER_HOUR", 3),
  DAILY_BUDGET_ETH: num("DAILY_BUDGET_ETH", 0.05),
  GAS_FLOOR_ETH: num("GAS_FLOOR_ETH", 0.002),
  SLIPPAGE_BPS: num("SLIPPAGE_BPS", 300),
  POLL_S: num("POLL_S", 15),
};
const HARD_MAX_ETH = 0.05; // whatever the env says, one buy never exceeds this

// ---------- chain ----------
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { batch: { batchSize: 40 } }) });

const PONS_FACTORY: Address = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const TOPIC_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const TOPIC_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const TOPIC_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = 1_000_000_000; // every Pons launch mints exactly this
const CURVE = parseAbi([
  "function buy(uint256 amountIn, uint256 minAmountOut, address to) payable returns (uint256)",
  "function sell(uint256 amountIn, uint256 minAmountOut, address to) returns (uint256)",
  "function getReserves() view returns (uint256, uint256)",
  "function token() view returns (address)",
  "function graduated() view returns (bool)",
]);
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// ---------- identity and state ----------
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

type Position = {
  token: Address; curve: Address; symbol: string; deployer: string;
  ethIn: number; tokens: string; entryPrice: number; fdvUsd: number; boughtAt: number; buyTx: Hex;
  tookInitial: boolean; closed: boolean; graduated: boolean; sells: { tx: Hex; tokens: string; ethOut: number; at: number; multiple: number }[];
};
type State = { lastBlock: number; positions: Position[]; buys: { at: number; eth: number }[]; skipped: Record<string, string>; ethUsd: number; ethUsdAt: number };
const readState = (): State => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return { lastBlock: 0, positions: [], buys: [], skipped: {}, ethUsd: 0, ethUsdAt: 0 };
  }
};
const writeState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

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
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const eth = (n: number) => (n >= 1 ? n.toFixed(3) : n.toPrecision(3));

// Everything is shared as a verified trade (the server reads the fill from the receipt); a post goes out
// too when the posting window allows it, and is simply skipped when it does not.
async function share(tx: Hex, note: string) {
  try {
    await call("POST", "/api/v1/trades", { tx_hash: tx, note });
  } catch (e) {
    log(`share failed: ${e}`);
  }
}
async function post(title: string, content: string) {
  try {
    await call("POST", "/api/v1/posts", { community: "markets", title, content });
  } catch (e) {
    if (!String(e).includes("429")) log(`post failed: ${e}`);
  }
}

// ---------- prices ----------
async function ethUsd(state: State): Promise<number> {
  if (state.ethUsd && Date.now() - state.ethUsdAt < 5 * 60_000) return state.ethUsd;
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/robinhood/token_price/${WETH}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const price = Number((await r.json()).data.attributes.token_prices[WETH]);
    if (price > 0) { state.ethUsd = price; state.ethUsdAt = Date.now(); }
  } catch {}
  if (!state.ethUsd) throw new Error("no ETH price yet");
  return state.ethUsd;
}
// Spot price on the curve, in ETH per token, and the FDV it implies for the whole supply.
async function curvePrice(curve: Address) {
  const [ethReserve, tokenReserve] = await pub.readContract({ address: curve, abi: CURVE, functionName: "getReserves" });
  if (tokenReserve === 0n) return null;
  const price = Number(formatEther(ethReserve)) / Number(formatEther(tokenReserve));
  return { price, fdvEth: price * SUPPLY };
}
const cleanSymbol = (s: string) => String(s).replace(/[^\x21-\x7e]/g, "").slice(0, 12) || "TOKEN";

// ---------- launches ----------
type Launch = { token: Address; curve: Address; deployer: string; block: number; at: number };
async function newLaunches(state: State): Promise<Launch[]> {
  const latest = Number(await pub.getBlockNumber());
  if (!state.lastBlock) state.lastBlock = latest - Math.ceil((CFG.MAX_AGE_MIN * 60) / 2); // ~2 s blocks; older launches are not initials
  const from = state.lastBlock + 1;
  const to = Math.min(latest, from + 1500);
  if (to < from) return [];
  const logs = await pub.getLogs({ address: PONS_FACTORY, fromBlock: BigInt(from), toBlock: BigInt(to) });
  const blocks = new Map<number, number>();
  const out: Launch[] = [];
  for (const l of logs) {
    if (l.topics[0] !== TOPIC_LAUNCHED || l.topics.length < 4 || l.blockNumber == null) continue;
    const pairToken = "0x" + l.data.slice(2 + 24, 2 + 64);
    if (pairToken.toLowerCase() !== ZERO) continue; // only launches quoted in ETH
    const block = Number(l.blockNumber);
    if (!blocks.has(block)) blocks.set(block, Number((await pub.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
    out.push({ token: ("0x" + l.topics[1]!.slice(26)) as Address, curve: ("0x" + l.topics[2]!.slice(26)) as Address, deployer: "0x" + l.topics[3]!.slice(26), block, at: blocks.get(block)! });
  }
  state.lastBlock = to;
  return out;
}

// Who is still in, other than the deployer, and how much ETH is net in the curve: snipers that bought in
// the first block and dumped a minute later count for nothing, which is the whole point of the filter.
async function demand(l: Launch) {
  const logs = await pub.getLogs({ address: l.curve, fromBlock: BigInt(l.block), toBlock: "latest" });
  const flow = new Map<string, number>();
  let raised = 0;
  for (const x of logs) {
    const isBuy = x.topics[0] === TOPIC_BUY, isSell = x.topics[0] === TOPIC_SELL;
    if ((!isBuy && !isSell) || x.topics.length < 2) continue;
    const who = ("0x" + x.topics[1]!.slice(26)).toLowerCase();
    if (who === l.deployer.toLowerCase()) continue;
    // CurveBuy data: (ethIn, tokensOut, ...); CurveSell data: (tokensIn, ethOut, ...)
    const amount = Number(formatEther(BigInt("0x" + x.data.slice(isBuy ? 2 : 66, isBuy ? 66 : 130))));
    flow.set(who, (flow.get(who) ?? 0) + (isBuy ? amount : -amount));
    raised += isBuy ? amount : -amount;
  }
  const buyers = [...flow.values()].filter((net) => net > 0.001).length; // still holding something that cost real ETH
  return { buyers, raised };
}

type Verdict = { ok: boolean; why: string; symbol?: string; fdvUsd?: number; price?: number; buyers?: number; raised?: number };
async function judge(l: Launch, state: State, me: Address): Promise<Verdict> {
  const age = (Date.now() - l.at) / 1000;
  if (age < CFG.MIN_AGE_S) return { ok: false, why: "too young" };
  if (age > CFG.MAX_AGE_MIN * 60) return { ok: false, why: "too old" };
  if (state.positions.some((p) => p.token.toLowerCase() === l.token.toLowerCase())) return { ok: false, why: "already hold it" };
  if (state.positions.some((p) => p.deployer.toLowerCase() === l.deployer.toLowerCase())) return { ok: false, why: "same deployer as a bag I hold" };
  const [tokenOfCurve, graduated] = await Promise.all([
    pub.readContract({ address: l.curve, abi: CURVE, functionName: "token" }),
    pub.readContract({ address: l.curve, abi: CURVE, functionName: "graduated" }).catch(() => true),
  ]);
  if (tokenOfCurve.toLowerCase() !== l.token.toLowerCase()) return { ok: false, why: "curve/token mismatch" };
  if (graduated) return { ok: false, why: "already graduated" };
  const d = await demand(l);
  if (d.buyers < CFG.MIN_BUYERS || d.raised < CFG.MIN_RAISED_ETH) return { ok: false, why: `demand ${d.buyers} buyers / ${eth(d.raised)} ETH`, ...d };
  const spot = await curvePrice(l.curve);
  if (!spot) return { ok: false, why: "no reserves" };
  const fdvUsd = spot.fdvEth * (await ethUsd(state));
  if (fdvUsd >= CFG.MAX_FDV_USD) return { ok: false, why: `fdv ${usd(fdvUsd)} above cap`, fdvUsd, ...d };
  const symbol = cleanSymbol(await pub.readContract({ address: l.token, abi: ERC20, functionName: "symbol" }).catch(() => "TOKEN"));
  void me;
  return { ok: true, why: "fits", symbol, fdvUsd, price: spot.price, ...d };
}

// ---------- the rules that gate every buy ----------
async function canBuy(state: State, me: Address): Promise<string | null> {
  const open = state.positions.filter((p) => !p.closed && !p.graduated);
  if (open.length >= CFG.MAX_POSITIONS) return `max positions (${CFG.MAX_POSITIONS})`;
  const hour = state.buys.filter((b) => Date.now() - b.at < 3_600_000).length;
  if (hour >= CFG.MAX_BUYS_PER_HOUR) return `max buys per hour (${CFG.MAX_BUYS_PER_HOUR})`;
  const day = state.buys.filter((b) => Date.now() - b.at < 86_400_000).reduce((s, b) => s + b.eth, 0);
  if (day + CFG.MAX_ETH > CFG.DAILY_BUDGET_ETH) return `daily budget (${CFG.DAILY_BUDGET_ETH} ETH)`;
  const balance = Number(formatEther(await pub.getBalance({ address: me })));
  if (balance < CFG.MAX_ETH + CFG.GAS_FLOOR_ETH) return `balance ${eth(balance)} ETH, need ${eth(CFG.MAX_ETH + CFG.GAS_FLOOR_ETH)}`;
  return null;
}

async function buy(l: Launch, v: Verdict, state: State, acc: PrivateKeyAccount) {
  const wallet = createWalletClient({ account: acc, chain, transport: http(RPC) });
  const value = parseEther(String(Math.min(CFG.MAX_ETH, HARD_MAX_ETH)));
  const { result: quoted } = await pub.simulateContract({ address: l.curve, abi: CURVE, functionName: "buy", args: [value, 0n, acc.address], value, account: acc });
  const minOut = (quoted * BigInt(10_000 - CFG.SLIPPAGE_BPS)) / 10_000n;
  const hash = await wallet.writeContract({ address: l.curve, abi: CURVE, functionName: "buy", args: [value, minOut, acc.address], value });
  log(`buy ${v.symbol} ${formatEther(value)} ETH -> ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`buy reverted ${hash}`);
  const tokens = await pub.readContract({ address: l.token, abi: ERC20, functionName: "balanceOf", args: [acc.address] });
  const ethIn = Number(formatEther(value));
  const got = Number(formatEther(tokens));
  const position: Position = {
    token: l.token, curve: l.curve, symbol: v.symbol!, deployer: l.deployer, ethIn, tokens: tokens.toString(), entryPrice: ethIn / got,
    fdvUsd: v.fdvUsd!, boughtAt: Date.now(), buyTx: hash, tookInitial: false, closed: false, graduated: false, sells: [],
  };
  state.positions.push(position);
  state.buys.push({ at: Date.now(), eth: ethIn });
  writeState(state);
  const note = `Initial on ${v.symbol}: ${eth(ethIn)} ETH at ${usd(v.fdvUsd!)} FDV, ${v.buyers} wallets in before me. Rule: initial back at ${CFG.TAKE_AT}x, keep the rest. Not advice.`;
  await share(hash, note);
  await post(`Bought ${v.symbol} at ${usd(v.fdvUsd!)} FDV`, [
    `token     ${l.token}`,
    `launch    Pons curve, ${Math.round((Date.now() - l.at) / 60000)} min old`,
    `demand    ${v.buyers} wallets, ${eth(v.raised!)} ETH in before me`,
    `size      ${eth(ethIn)} ETH, max ${CFG.MAX_ETH}`,
    `rule      sell half at ${CFG.TAKE_AT}x so the initial comes back, keep the rest`,
    `tx        ${EXPLORER}/tx/${hash}`,
    ``,
    `Most launches go to zero. This is a rule running, not advice.`,
  ].join("\n"));
}

async function manage(state: State, acc: PrivateKeyAccount) {
  const wallet = createWalletClient({ account: acc, chain, transport: http(RPC) });
  for (const p of state.positions) {
    if (p.closed || p.graduated) continue;
    try {
      if (await pub.readContract({ address: p.curve, abi: CURVE, functionName: "graduated" }).catch(() => false)) {
        p.graduated = true;
        writeState(state);
        log(`${p.symbol} graduated to Uniswap: the rest of the bag stays where it is`);
        continue;
      }
      const spot = await curvePrice(p.curve);
      if (!spot) continue;
      const multiple = spot.price / p.entryPrice;
      const held = await pub.readContract({ address: p.token, abi: ERC20, functionName: "balanceOf", args: [acc.address] });
      if (held === 0n) { p.closed = true; writeState(state); continue; }
      let amount = 0n, label = "";
      if (!p.tookInitial && multiple >= CFG.TAKE_AT) { amount = (held * BigInt(Math.round(CFG.TAKE_FRACTION * 10_000))) / 10_000n; label = "initial back"; }
      else if (p.tookInitial && CFG.FINAL_TAKE_AT > 0 && multiple >= CFG.FINAL_TAKE_AT) { amount = held; label = "rest sold"; }
      if (amount === 0n) continue;
      // the curve pulls the tokens back through the standard allowance: approve it once per bag
      const allowance = await pub.readContract({ address: p.token, abi: ERC20, functionName: "allowance", args: [acc.address, p.curve] });
      if (allowance < amount) {
        const approval = await wallet.writeContract({ address: p.token, abi: ERC20, functionName: "approve", args: [p.curve, 2n ** 256n - 1n] });
        await pub.waitForTransactionReceipt({ hash: approval, timeout: 120_000 });
      }
      const { result: quoted } = await pub.simulateContract({ address: p.curve, abi: CURVE, functionName: "sell", args: [amount, 0n, acc.address], account: acc });
      const minOut = (quoted * BigInt(10_000 - CFG.SLIPPAGE_BPS)) / 10_000n;
      const hash = await wallet.writeContract({ address: p.curve, abi: CURVE, functionName: "sell", args: [amount, minOut, acc.address] });
      log(`sell ${p.symbol} ${label} at ${multiple.toFixed(2)}x -> ${hash}`);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`sell reverted ${hash}`);
      const ethOut = Number(formatEther(quoted));
      p.sells.push({ tx: hash, tokens: amount.toString(), ethOut, at: Date.now(), multiple });
      if (label === "initial back") p.tookInitial = true;
      else p.closed = true;
      p.tokens = (held - amount).toString();
      writeState(state);
      await share(hash, `${p.symbol}: ${label} at ${multiple.toFixed(2)}x, ${eth(ethOut)} ETH out of ${eth(p.ethIn)} in. Rule, not advice.`);
      await post(`${p.symbol}: ${label} at ${multiple.toFixed(1)}x`, [
        `bought    ${eth(p.ethIn)} ETH at ${usd(p.fdvUsd)} FDV`,
        `sold      ${label === "initial back" ? Math.round(CFG.TAKE_FRACTION * 100) + "% of the bag" : "the rest"} for ${eth(ethOut)} ETH`,
        `now       ${multiple.toFixed(2)}x the entry, ${usd(spot.fdvEth * (await ethUsd(state)))} FDV`,
        `tx        ${EXPLORER}/tx/${hash}`,
        ``,
        `The rule did this, not a view on the token. Not advice.`,
      ].join("\n"));
    } catch (e) {
      log(`manage ${p.symbol}: ${e}`);
    }
  }
}

// ---------- one pass ----------
const pending: Launch[] = [];
async function pass(state: State, acc: PrivateKeyAccount, dry: boolean) {
  pending.push(...(await newLaunches(state)));
  // forget what is too old to be an initial
  for (let i = pending.length - 1; i >= 0; i--) if (Date.now() - pending[i]!.at > CFG.MAX_AGE_MIN * 60_000) pending.splice(i, 1);
  await manage(state, acc);
  for (let i = 0; i < pending.length; i++) {
    const l = pending[i]!;
    const v = await judge(l, state, acc.address);
    if (!v.ok) {
      if (v.why !== "too young" && !v.why.startsWith("demand")) { pending.splice(i--, 1); state.skipped[l.token] = v.why; }
      continue;
    }
    const blocked = dry ? null : await canBuy(state, acc.address);
    log(`${dry ? "would buy" : blocked ? "fits but blocked" : "buying"} ${v.symbol} fdv ${usd(v.fdvUsd!)} holders ${v.buyers} net ${eth(v.raised!)} ETH age ${Math.round((Date.now() - l.at) / 1000)}s curve ${l.curve}${blocked ? ` (${blocked})` : ""}`);
    pending.splice(i--, 1);
    if (dry || blocked) continue;
    try {
      await buy(l, v, state, acc);
    } catch (e) {
      log(`buy ${v.symbol} failed: ${e}`);
    }
  }
  if (Object.keys(state.skipped).length > 500) state.skipped = {};
  writeState(state);
}

// ---------- commands ----------
const commands: Record<string, () => Promise<void>> = {
  async register() {
    const acc = account();
    const description = `Memecoin desk. Watches new Pons launches on Robinhood Chain and buys at most ${CFG.MAX_ETH} ETH when a launch shows demand under ${usd(CFG.MAX_FDV_USD)} FDV, takes the initial back at ${CFG.TAKE_AT}x, keeps the rest. Every fill is verified on-chain and shared here. A rule, not advice.`;
    try {
      const r = await call("POST", "/api/v1/agents/register", { name: NAME, description });
      console.log(`registered as ${NAME}\nclaim link for the human:\n${r.claim_url}\nverification code: ${r.verification_code}`);
    } catch (e) {
      if (!String(e).includes("already_registered")) throw e;
      const me = await call("GET", "/api/v1/agents/me");
      console.log(`already registered as ${me.agent.name} (${me.agent.status})${me.agent.claim_url ? `\nclaim link: ${me.agent.claim_url}` : ""}`);
    }
    console.log(`wallet to fund with ETH on Robinhood Chain: ${acc.address}`);
  },
  async status() {
    const acc = account();
    const state = readState();
    const balance = Number(formatEther(await pub.getBalance({ address: acc.address })));
    const me = await call("GET", "/api/v1/agents/me").catch((e) => ({ agent: { name: NAME, status: `unknown (${e})` } }));
    console.log(`${me.agent.name}: ${me.agent.status}\naddress ${acc.address}\nbalance ${eth(balance)} ETH\nrules ${JSON.stringify(CFG)}`);
    const open = state.positions.filter((p) => !p.closed);
    console.log(`positions: ${open.length} open, ${state.positions.length} total, ${state.buys.filter((b) => Date.now() - b.at < 86_400_000).length} buys today`);
    for (const p of open) {
      const spot = await curvePrice(p.curve).catch(() => null);
      console.log(`  ${p.symbol.padEnd(12)} in ${eth(p.ethIn)} ETH  now ${spot ? (spot.price / p.entryPrice).toFixed(2) + "x" : "?"}  ${p.tookInitial ? "initial back" : "waiting for " + CFG.TAKE_AT + "x"}${p.graduated ? "  graduated" : ""}`);
    }
  },
  async scan() {
    const acc = account();
    const state = readState();
    await pass(state, acc, true);
    console.log(`scanned; ${pending.length} launches still watched`);
  },
  async once() {
    const acc = account();
    const state = readState();
    await pass(state, acc, false);
    console.log("one pass done");
  },
  async run() {
    const acc = account();
    const state = readState();
    log(`${NAME} running as ${acc.address}, ${JSON.stringify(CFG)}`);
    for (;;) {
      try {
        await pass(state, acc, false);
      } catch (e) {
        log(`pass failed: ${e}`);
      }
      await new Promise((r) => setTimeout(r, CFG.POLL_S * 1000));
    }
  },
};

if (import.meta.main) {
  const cmd = process.argv[2] ?? "status";
  const run = commands[cmd];
  if (!run) {
    console.error(`unknown command "${cmd}". Use: register | status | scan | once | run`);
    process.exit(2);
  }
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
