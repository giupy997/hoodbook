import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { db } from "./db";
import { emit } from "./events";
import { leafFor, merkleRoot } from "./merkle";

export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.anchor.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});

export const anchorAbi = parseAbi([
  "function anchor(bytes32 root, uint256 fromAction, uint256 toAction) returns (uint256 batchId)",
  "function lastAction() view returns (uint256)",
  "event Anchored(uint256 indexed batchId, bytes32 indexed root, uint256 fromAction, uint256 toAction)",
]);

export const anchoringEnabled = Boolean(config.anchor.contract && config.anchor.privateKey);

type ActionForLeaf = { id: number; message: string; address: Hex };
let running = false;

// Commits every action not yet on-chain as one Merkle root. The contract only accepts
// contiguous ranges, so the next batch always starts right after the chain's lastAction.
export async function anchorOnce(): Promise<{ count: number; txHash?: Hex } | null> {
  if (!anchoringEnabled || running) return null;
  running = true;
  try {
    const account = privateKeyToAccount(config.anchor.privateKey as Hex);
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http() });
    const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http() });
    const address = config.anchor.contract as Hex;

    for (const sent of db.query("SELECT tx_hash FROM anchors WHERE status = 'sent'").all() as { tx_hash: Hex }[]) {
      const receipt = await publicClient.getTransactionReceipt({ hash: sent.tx_hash }).catch(() => null);
      if (receipt) recordReceipt(receipt);
    }

    const onchainLast = Number(await publicClient.readContract({ address, abi: anchorAbi, functionName: "lastAction" }));
    const rows = db
      .query("SELECT a.id, a.message, g.address FROM actions a JOIN agents g ON g.id = a.agent_id WHERE a.id > ? ORDER BY a.id LIMIT ?")
      .all(onchainLast, config.anchor.maxBatch) as ActionForLeaf[];
    let contiguous = 0;
    while (contiguous < rows.length && rows[contiguous]!.id === onchainLast + 1 + contiguous) contiguous++;
    const batch = rows.slice(0, contiguous);
    if (batch.length === 0) return { count: 0 };

    const leaves = batch.map((r) => leafFor(r.id, r.address, r.message));
    const root = merkleRoot(leaves);
    const from = batch[0]!.id;
    const to = batch[batch.length - 1]!.id;

    const { request } = await publicClient.simulateContract({ account, address, abi: anchorAbi, functionName: "anchor", args: [root, BigInt(from), BigInt(to)] });
    const txHash = await walletClient.writeContract(request);
    db.transaction(() => {
      db.query("INSERT INTO anchors (root, from_action, to_action, tx_hash, status, created_at) VALUES (?, ?, ?, ?, 'sent', ?)").run(root, from, to, txHash, Date.now());
      const setLeaf = db.query("UPDATE actions SET leaf = ? WHERE id = ?");
      batch.forEach((r, i) => setLeaf.run(leaves[i]!, r.id));
    })();

    recordReceipt(await publicClient.waitForTransactionReceipt({ hash: txHash }));
    return { count: batch.length, txHash };
  } finally {
    running = false;
  }
}

function recordReceipt(receipt: { transactionHash: Hex; status: "success" | "reverted"; blockNumber: bigint; logs: any[] }) {
  const [event] = parseEventLogs({ abi: anchorAbi, logs: receipt.logs, eventName: "Anchored" });
  const confirmed = receipt.status === "success" && Boolean(event);
  db.query("UPDATE anchors SET status = ?, block_number = ?, batch_id = ? WHERE tx_hash = ?").run(
    confirmed ? "confirmed" : "failed",
    Number(receipt.blockNumber),
    event ? Number(event.args.batchId) : null,
    receipt.transactionHash,
  );
  if (!confirmed) return;
  const row = db.query("SELECT batch_id, root, from_action, to_action, tx_hash, block_number, created_at FROM anchors WHERE tx_hash = ?").get(receipt.transactionHash) as
    | { tx_hash: string }
    | null;
  if (row) emit("anchor", { ...row, explorer_url: `${EXPLORER}/tx/${row.tx_hash}` });
}

export function startAnchorLoop() {
  if (!anchoringEnabled) {
    console.log("[anchor] disabled: set ANCHOR_CONTRACT and ANCHOR_PRIVATE_KEY to anchor actions on Robinhood Chain");
    return;
  }
  const tick = () =>
    anchorOnce()
      .then((r) => r?.count && console.log(`[anchor] ${r.count} actions -> ${EXPLORER}/tx/${r.txHash}`))
      .catch((e) => console.error("[anchor]", e?.shortMessage ?? e?.message ?? e));
  setInterval(tick, config.anchor.everyMs);
  tick();
}
