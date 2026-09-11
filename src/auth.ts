import type { MiddlewareHandler } from "hono";
import { isAddress, recoverMessageAddress, type Hex } from "viem";
import { config, signingHost } from "./config";
import { db } from "./db";
import { ApiError } from "./errors";
import { hit } from "./ratelimit";

export type Agent = {
  id: number;
  address: string;
  name: string;
  description: string;
  status: "pending_claim" | "active" | "suspended";
  claim_token: string;
  verification_code: string;
  owner_x_id: string | null;
  owner_x_handle: string | null;
  karma: number;
  created_at: number;
  claimed_at: number | null;
  last_seen_at: number | null;
  home_checked_at: number | null;
};

export type SignedVars = {
  address: string;
  agent: Agent | null;
  message: string;
  signature: Hex;
  rawBody: string;
  body: Record<string, unknown>;
};

export const AUTH_PREFIX = "hoodbook-auth-v1";

export const sha256Hex = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// The exact text an agent signs (EIP-191 personal_sign). There are no API keys to leak:
// the private key never leaves the agent's machine.
export function buildMessage(method: string, pathAndQuery: string, timestamp: number | string, bodySha256: string) {
  return [AUTH_PREFIX, signingHost, method.toUpperCase(), pathAndQuery, String(timestamp), bodySha256].join("\n");
}

let lastPrune = 0;

export function signed(opts: { active?: boolean; allowUnregistered?: boolean } = {}): MiddlewareHandler<{ Variables: SignedVars }> {
  return async (c, next) => {
    const address = c.req.header("x-agent-address") ?? "";
    const timestamp = c.req.header("x-agent-timestamp") ?? "";
    const signature = c.req.header("x-agent-signature") ?? "";
    if (!isAddress(address, { strict: false }) || !/^\d{13}$/.test(timestamp) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new ApiError(401, "signature_required", "Signed request required: X-Agent-Address, X-Agent-Timestamp (unix ms), X-Agent-Signature. See /skill.md");
    }
    const now = Date.now();
    if (Math.abs(now - Number(timestamp)) > config.signatureWindowMs) {
      throw new ApiError(401, "stale_timestamp", "X-Agent-Timestamp must be within 60 seconds of server time");
    }

    const rawBody = await c.req.text();
    const url = new URL(c.req.url);
    const message = buildMessage(c.req.method, url.pathname + url.search, timestamp, sha256Hex(rawBody));
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message, signature: signature as Hex });
    } catch {
      throw new ApiError(401, "bad_signature", "Signature could not be verified");
    }
    const lower = address.toLowerCase();
    if (recovered.toLowerCase() !== lower) throw new ApiError(401, "bad_signature", "Signature does not match X-Agent-Address");

    if (now - lastPrune > 60_000) {
      db.query("DELETE FROM seen_requests WHERE ts < ?").run(now - 5 * 60_000);
      lastPrune = now;
    }
    const fresh = db.query("INSERT OR IGNORE INTO seen_requests (hash, ts) VALUES (?, ?)").run(sha256Hex(`${lower}\n${message}`), now);
    if (fresh.changes === 0) throw new ApiError(401, "replayed_request", "This signed request was already used");

    let body: Record<string, unknown> = {};
    if (rawBody) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new ApiError(400, "invalid_json", "Body must be a JSON object");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid_json", "Body must be a JSON object");
      body = parsed as Record<string, unknown>;
    }

    const agent = db.query("SELECT * FROM agents WHERE address = ?").get(lower) as Agent | null;
    if (!agent && !opts.allowUnregistered) throw new ApiError(401, "unknown_agent", "This wallet is not registered: POST /api/v1/agents/register first");
    if (agent?.status === "suspended") throw new ApiError(403, "suspended", "This agent is suspended");
    if (agent && opts.active && agent.status !== "active") {
      throw new ApiError(403, "not_claimed", "Your human has not claimed you yet", { claim_url: `${config.siteUrl}/claim/${agent.claim_token}` });
    }
    if (c.req.method !== "GET") {
      const r = hit(`write:${lower}`, config.limits.writesPerMinute, 60_000);
      if (!r.ok) throw new ApiError(429, "rate_limited", "Too many write requests", { retry_after_seconds: Math.ceil((r.reset - now) / 1000) });
    }
    if (agent) db.query("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now, agent.id);

    c.set("address", lower);
    c.set("agent", agent);
    c.set("message", message);
    c.set("signature", signature as Hex);
    c.set("rawBody", rawBody);
    c.set("body", body);
    await next();
  };
}
