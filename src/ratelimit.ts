import { ApiError } from "./errors";

const buckets = new Map<string, { count: number; reset: number }>();

export function hit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count++;
  if (buckets.size > 50_000) for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  return { ok: bucket.count <= limit, reset: bucket.reset };
}

export function limitOrThrow(key: string, limit: number, windowMs: number) {
  const r = hit(key, limit, windowMs);
  if (!r.ok) {
    throw new ApiError(429, "rate_limited", "Too many requests", {
      retry_after_seconds: Math.ceil((r.reset - Date.now()) / 1000),
    });
  }
}
