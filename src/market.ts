import { createPublicClient, formatUnits, getAddress, http, type Address, type Hex } from "viem";
import { robinhoodChain } from "./anchor";
import { ApiError } from "./errors";

// Re-checksummed from lowercase: copied addresses are often mis-cased, and viem rejects a bad checksum.
const checksummed = (address: string): Address => getAddress(address.toLowerCase());

// Uniswap v3 on Robinhood Chain, the same deployment the RH4 launchpad trades on
// (checked on-chain on 2026-09-11: SwapRouter02.WETH9() returns the WETH below).
export const DEX = {
  router: checksummed("0xcaf681a66d020601342297493863e78c959e5cb2"),
  v3Factory: checksummed("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
  weth: checksummed("0x0bd7d308f8e1639fab988df18a8011f41eacad73"),
};

// Pons, the launchpad most new memecoins on Robinhood Chain come from: every launch gets its own bonding
// curve contract, bought and sold directly (buy/sell on the curve, no router), until it graduates to Uniswap.
export const PONS = {
  factory: checksummed("0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"),
  launchedTopic: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
  buyTopic: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  sellTopic: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
};

export type Asset = { symbol: string; address: Address; decimals: number };

const asset = (symbol: string, address: string, decimals = 18): Asset => ({ symbol, address: checksummed(address), decimals });

// Tokenized stocks with WETH pools on Robinhood Chain. ETH (native or WETH) is the other side of every route.
export const ASSETS: Asset[] = [
  asset("NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
  asset("TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"),
  asset("AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"),
  asset("META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35"),
  asset("SPY", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C"),
  asset("QQQ", "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68"),
  asset("MSTR", "0xec262a75e413fAfD0dF80480274532C79D42da09"),
  asset("COIN", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b"),
  asset("CRCL", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5"),
  asset("TSM", "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA"),
  asset("MU", "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD"),
  asset("SNDK", "0xB90A19fF0Af67f7779afF50A882A9CfF42446400"),
  asset("RDDT", "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C"),
  asset("RBLX", "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8"),
  asset("HIMS", "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09"),
  asset("LLY", "0x8005d266423c7ea827372c9c864491e5786600ea"),
  asset("QUBT", "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4"),
  asset("SPCX", "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa"),
  asset("AMC", "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B"),
  asset("DJT", "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516"),
  asset("GLD", "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e"),
  asset("SGOV", "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5"),
  asset("USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", 6),
];

const ETH: Asset = { symbol: "ETH", address: DEX.weth, decimals: 18 };
const BY_ADDRESS = new Map<string, Asset>([[DEX.weth.toLowerCase(), ETH], ...ASSETS.map((a): [string, Asset] => [a.address.toLowerCase(), a])]);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WITHDRAWAL_TOPIC = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const ZERO = "0x0000000000000000000000000000000000000000";
const FEE_TIERS = [100, 500, 3000, 10_000] as const;

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const POOL_ABI = [
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
  },
] as const;

const client = createPublicClient({ chain: robinhoodChain, transport: http(undefined, { batch: { batchSize: 40 } }) });

export type Leg = Asset & { raw: bigint };
export type ParsedTrade = { sell: Leg; buy: Leg };
export type VerifiedTrade = ParsedTrade & { blockNumber: number; tradedAt: number };
type LogLike = { address: string; topics: readonly string[]; data: string };

const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(26)}`.toLowerCase();

// Reads what a swap did to the agent's wallet from the receipt alone: tokens that left it, tokens that
// arrived, ETH sent as msg.value and ETH unwrapped by the router. One listed asset out, one listed asset in.
// Robinhood Chain's WETH has no Withdrawal event: unwrapping shows up as a Transfer from the router to 0x0.
export function parseTrade(tx: { agent: string; to: string | null; value: bigint; status: string; logs: readonly LogLike[] }): ParsedTrade {
  const agent = tx.agent.toLowerCase();
  const router = DEX.router.toLowerCase();
  const weth = DEX.weth.toLowerCase();
  const zero = ZERO.toLowerCase();
  if (tx.status !== "success") throw new ApiError(400, "trade_reverted", "That transaction reverted");
  const to = (tx.to ?? "").toLowerCase();
  if (to !== router) {
    const curve = parseCurveTrade(agent, to, tx.value, tx.logs);
    if (curve) return curve;
    throw new ApiError(400, "not_a_router_swap", "Only swaps sent to the Uniswap router or to a Pons launch curve on Robinhood Chain can be shared");
  }

  const net = new Map<string, bigint>();
  const move = (token: string, amount: bigint) => net.set(token, (net.get(token) ?? 0n) + amount);
  if (tx.value > 0n) move(weth, -tx.value);
  for (const log of tx.logs) {
    const token = log.address.toLowerCase();
    if (!BY_ADDRESS.has(token) || log.data.length < 3) continue;
    if (log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3) {
      const amount = BigInt(log.data);
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      if (from === agent) move(token, -amount);
      if (to === agent) move(token, amount);
      if (token === weth && from === router && to === zero) move(weth, amount);
    } else if (log.topics[0] === WITHDRAWAL_TOPIC && token === weth && topicAddress(log.topics[1]) === router) {
      move(weth, BigInt(log.data));
    }
  }

  const sold = [...net].filter(([, amount]) => amount < 0n);
  const bought = [...net].filter(([, amount]) => amount > 0n);
  if (sold.length !== 1 || bought.length !== 1) {
    throw new ApiError(400, "not_a_simple_swap", "The transaction must swap exactly one listed asset for one other listed asset from your wallet");
  }
  return {
    sell: { ...BY_ADDRESS.get(sold[0]![0])!, raw: -sold[0]![1] },
    buy: { ...BY_ADDRESS.get(bought[0]![0])!, raw: bought[0]![1] },
  };
}

// A trade on a Pons bonding curve: the transaction goes to the curve itself, which emits CurveBuy
// (ETH in as msg.value, tokens out) or CurveSell (tokens in, ETH out in the event data, paid natively).
// The token is whatever the curve sells: its symbol is read from the chain afterwards, never trusted blindly.
function parseCurveTrade(agent: string, curve: string, value: bigint, logs: readonly LogLike[]): ParsedTrade | null {
  const weth = DEX.weth.toLowerCase();
  const word = (data: string, i: number) => BigInt("0x" + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  const event = logs.find((l) => l.address.toLowerCase() === curve && (l.topics[0] === PONS.buyTopic || l.topics[0] === PONS.sellTopic) && l.data.length >= 2 + 128);
  if (!curve || !event) return null;
  const transfers = logs.filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3 && l.address.toLowerCase() !== weth && l.data.length >= 66);
  const unknown = (address: string, raw: bigint): Leg => ({ symbol: "", address: checksummed(address), decimals: 18, raw });
  if (event.topics[0] === PONS.buyTopic) {
    const received = transfers.find((l) => topicAddress(l.topics[2]) === agent && topicAddress(l.topics[1]) === curve);
    if (!received || value <= 0n) return null;
    return { sell: { symbol: "ETH", address: DEX.weth, decimals: 18, raw: value }, buy: unknown(received.address, BigInt(received.data)) };
  }
  const sent = transfers.find((l) => topicAddress(l.topics[1]) === agent);
  const ethOut = word(event.data, 1);
  if (!sent || ethOut <= 0n) return null;
  return { sell: unknown(sent.address, BigInt(sent.data)), buy: { symbol: "ETH", address: DEX.weth, decimals: 18, raw: ethOut } };
}

const tokenMeta = new Map<string, Promise<{ symbol: string; decimals: number }>>();
// Symbol and decimals of a token that is not on the list, from the contract. Names are chosen by whoever
// deployed the token, so the symbol is trimmed to plain printable characters; unreadable ones get the address.
function readTokenMeta(address: Address): Promise<{ symbol: string; decimals: number }> {
  const key = address.toLowerCase();
  let hit = tokenMeta.get(key);
  if (!hit) {
    hit = (async () => {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => ""),
        client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      ]);
      const clean = String(symbol).replace(/[^\x21-\x7e]/g, "").slice(0, 12);
      return { symbol: clean || `${address.slice(0, 6)}…${address.slice(-4)}`, decimals: Number(decimals) };
    })();
    tokenMeta.set(key, hit);
    hit.catch(() => tokenMeta.delete(key));
  }
  return hit;
}

async function resolveLeg(leg: Leg): Promise<Leg> {
  if (leg.symbol) return leg;
  return { ...leg, ...(await readTokenMeta(leg.address)) };
}

async function fetchTrade(hash: Hex, agent: string): Promise<VerifiedTrade> {
  let found: [Awaited<ReturnType<typeof client.getTransaction>>, Awaited<ReturnType<typeof client.getTransactionReceipt>>] | null = null;
  for (let attempt = 0; attempt < 4 && !found; attempt++) {
    try {
      found = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!found) throw new ApiError(404, "tx_not_found", "Transaction not found on Robinhood Chain yet: wait for it to confirm and try again");
  const [tx, receipt] = found;
  if (tx.from.toLowerCase() !== agent.toLowerCase()) throw new ApiError(403, "not_your_trade", "That transaction was not sent from your wallet");
  const parsed = parseTrade({ agent, to: tx.to, value: tx.value, status: receipt.status, logs: receipt.logs });
  const [block, sell, buy] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), resolveLeg(parsed.sell), resolveLeg(parsed.buy)]);
  return { sell, buy, blockNumber: Number(receipt.blockNumber), tradedAt: Number(block.timestamp) * 1000 };
}

type Verifier = (hash: Hex, agent: string) => Promise<VerifiedTrade>;
let verifier: Verifier = fetchTrade;

export const verifyTrade: Verifier = (hash, agent) => verifier(hash, agent);

// Tests swap the chain lookup for a stub; null restores the real one.
export function setTradeVerifier(stub: Verifier | null) {
  verifier = stub ?? fetchTrade;
}

export type Market = Asset & { price_eth: number | null; pool: Address | null; fee: number | null; weth_depth: number };

async function readMarket(a: Asset): Promise<Market> {
  const pools = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      const pool = await client.readContract({ address: DEX.v3Factory, abi: FACTORY_ABI, functionName: "getPool", args: [a.address, DEX.weth, fee] });
      if (pool === ZERO) return null;
      const depth = await client.readContract({ address: DEX.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [pool] });
      return { pool, fee, depth };
    }),
  );
  const best = pools.filter((p): p is NonNullable<typeof p> => p !== null).sort((x, y) => (y.depth > x.depth ? 1 : -1))[0];
  const wethDepth = best ? Number(formatUnits(best.depth, 18)) : 0;
  if (!best || wethDepth < 0.05) return { ...a, price_eth: null, pool: best?.pool ?? null, fee: best?.fee ?? null, weth_depth: wethDepth };
  const [sqrtPriceX96] = await client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "slot0" });
  const token1PerToken0 = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const rawEthPerToken = DEX.weth.toLowerCase() < a.address.toLowerCase() ? 1 / token1PerToken0 : token1PerToken0;
  return { ...a, price_eth: rawEthPerToken * 10 ** (a.decimals - 18), pool: best.pool, fee: best.fee, weth_depth: wethDepth };
}

let marketsCache: { t: number; value: Promise<Market[]> } | null = null;

// Spot prices from each asset's deepest WETH pool, refreshed at most once a minute.
export function getMarkets(): Promise<Market[]> {
  if (marketsCache && Date.now() - marketsCache.t < 60_000) return marketsCache.value;
  const value = Promise.all(ASSETS.map(readMarket));
  marketsCache = { t: Date.now(), value };
  value.catch(() => {
    if (marketsCache?.value === value) marketsCache = null;
  });
  return value;
}

export async function ethValueOf(sell: Leg, buy: Leg): Promise<number | null> {
  if (sell.symbol === "ETH") return Number(formatUnits(sell.raw, 18));
  if (buy.symbol === "ETH") return Number(formatUnits(buy.raw, 18));
  const price = (await getMarkets()).find((m) => m.symbol === sell.symbol)?.price_eth;
  return price ? Number(formatUnits(sell.raw, sell.decimals)) * price : null;
}
