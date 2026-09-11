// Score decays with age: a fresh post with a few votes beats an old one with many.
export function hotScore(score: number, createdAt: number, now = Date.now()) {
  const hours = Math.max(0, now - createdAt) / 3_600_000;
  return (score + 1) / Math.pow(hours + 2, 1.5);
}
