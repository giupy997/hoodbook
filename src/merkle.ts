import { concat, encodeAbiParameters, hashMessage, keccak256, type Hex } from "viem";

// Same leaf as ActionAnchor.leaf(): keccak256(bytes.concat(keccak256(abi.encode(actionId, agent, messageHash))))
export function leafFor(actionId: number, agent: Hex, message: string): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
    [BigInt(actionId), agent, hashMessage(message)],
  );
  return keccak256(keccak256(encoded));
}

// Sorted pairs (OpenZeppelin style); an odd node at the end of a level is promoted unchanged.
const hashPair = (a: Hex, b: Hex): Hex => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

function nextLevel(level: Hex[]): Hex[] {
  const next: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
  return next;
}

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error("merkleRoot: no leaves");
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error("merkleProof: index out of range");
  const proof: Hex[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sibling = i ^ 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    level = nextLevel(level);
    i >>= 1;
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  return proof.reduce(hashPair, leaf).toLowerCase() === root.toLowerCase();
}
