// Read-only view of Pons, the launchpad most memecoins on Robinhood Chain come from: launches, demand on a
// curve, the curve's price. Shared by the agents that sell or act on this data. Nothing here signs anything.
import { createPublicClient, defineChain, formatEther, http, parseAbi, type Address } from "viem";

export const RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
export const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC, { batch: { batchSize: 40 } }) });

export const PONS_FACTORY: Address = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
export const TOPIC_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
export const TOPIC_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
export const TOPIC_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const SUPPLY = 1_000_000_000;
export const CURVE = parseAbi([
  "function getReserves() view returns (uint256, uint256)",
  "function token() view returns (address)",
  "function graduated() view returns (bool)",
]);
export const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export const cleanSymbol = (s: string) => String(s).replace(/[^\x21-\x7e]/g, "").slice(0, 12) || "TOKEN";

let ethPrice = { usd: Number(process.env.ETH_USD_FIXED) || 0, at: 0 };
export async function ethUsd(): Promise<number> {
  if (process.env.ETH_USD_FIXED) return ethPrice.usd; // tests and dry runs pin the price
  if (ethPrice.usd && Date.now() - ethPrice.at < 5 * 60_000) return ethPrice.usd;
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/robinhood/token_price/${WETH}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const price = Number(((await r.json()) as any).data.attributes.token_prices[WETH]);
    if (price > 0) ethPrice = { usd: price, at: Date.now() };
  } catch {}
  if (!ethPrice.usd) throw new Error("no ETH price yet");
  return ethPrice.usd;
}

export type Launch = { token: Address; curve: Address; deployer: string; block: number; at: number };

/** Launches quoted in ETH between two blocks (at most 1500 apart), with their block time. */
export async function launchesBetween(from: number, to: number): Promise<Launch[]> {
  if (to < from) return [];
  let logs: { topics: `0x${string}`[]; data: `0x${string}`; blockNumber: `0x${string}` }[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      logs = (await pub.request({ method: "eth_getLogs", params: [{ address: PONS_FACTORY, topics: [TOPIC_LAUNCHED], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${Math.min(to, from + 1500).toString(16)}` }] })) as any;
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  const blocks = new Map<number, number>();
  const out: Launch[] = [];
  for (const l of logs) {
    if (l.topics[0] !== TOPIC_LAUNCHED || l.topics.length < 4 || l.blockNumber == null) continue;
    if (("0x" + l.data.slice(2 + 24, 2 + 64)).toLowerCase() !== ZERO) continue;
    const block = Number(l.blockNumber);
    if (!blocks.has(block)) blocks.set(block, Number((await pub.getBlock({ blockNumber: BigInt(block) })).timestamp) * 1000);
    out.push({ token: ("0x" + l.topics[1]!.slice(26)) as Address, curve: ("0x" + l.topics[2]!.slice(26)) as Address, deployer: "0x" + l.topics[3]!.slice(26), block, at: blocks.get(block)! });
  }
  return out;
}

/** Wallets still holding what they bought (deployer excluded) and the ETH net of dumps. */
export async function curveLogs(curve: Address, fromBlock: number): Promise<{ topics: `0x${string}`[]; data: `0x${string}`; blockNumber: `0x${string}` }[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await pub.request({ method: "eth_getLogs", params: [{ address: curve, topics: [[TOPIC_BUY, TOPIC_SELL]], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: "latest" }] })) as any;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function demand(curve: Address, fromBlock: number, deployer: string) {
  const logs = await curveLogs(curve, fromBlock);
  const flow = new Map<string, number>();
  let raised = 0, buys = 0, sells = 0;
  for (const x of logs) {
    const isBuy = x.topics[0] === TOPIC_BUY, isSell = x.topics[0] === TOPIC_SELL;
    if ((!isBuy && !isSell) || x.topics.length < 2) continue;
    const who = ("0x" + x.topics[1]!.slice(26)).toLowerCase();
    if (who === deployer.toLowerCase()) continue;
    const amount = Number(formatEther(BigInt("0x" + x.data.slice(isBuy ? 2 : 66, isBuy ? 66 : 130))));
    flow.set(who, (flow.get(who) ?? 0) + (isBuy ? amount : -amount));
    raised += isBuy ? amount : -amount;
    if (isBuy) buys++; else sells++;
  }
  return { holders: [...flow.values()].filter((net) => net > 0.001).length, net_eth: raised, buys, sells };
}

/** Spot price on the curve in ETH per token and the FDV it implies. */
export async function curvePrice(curve: Address) {
  const [ethReserve, tokenReserve] = await pub.readContract({ address: curve, abi: CURVE, functionName: "getReserves" });
  if (tokenReserve === 0n) return null;
  const price = Number(formatEther(ethReserve)) / Number(formatEther(tokenReserve));
  return { price, fdv_eth: price * SUPPLY, eth_reserve: Number(formatEther(ethReserve)) };
}
