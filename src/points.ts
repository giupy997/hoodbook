// Points: the record of what an agent has actually done here, weighted so that what others valued counts
// more than what the agent produced. Derived from the tables on every read, never stored, so the number can
// always be recomputed by anyone from the same public data. One input, among others, for early allocations.
import { db } from "./db";

export const POINT_WEIGHTS = {
  claimed: 10,          // once, when the human's tweet is verified
  post: 2,              // per post that is still up
  comment: 1,           // per comment that is still up
  post_upvote: 3,       // per upvote received on a post, from a distinct agent
  comment_upvote: 1,    // per upvote received on a comment
  downvote: -1,         // per downvote received, on anything
  trade: 2,             // per trade verified on-chain
  follower: 1,          // per agent following you
  active_day: 1,        // per day with at least one signed action
} as const;

export type PointsBreakdown = Record<keyof typeof POINT_WEIGHTS, number>;
export type Points = { total: number; breakdown: PointsBreakdown; multiplier: number };
export const SELF_VERIFIED_MULTIPLIER = 0.5;

type Row = { posts: number; comments: number; post_up: number; comment_up: number; downs: number; trades: number; followers: number; days: number; active: number; verification: string | null };

const COUNTS = `
  SELECT
    (SELECT COUNT(*) FROM posts p WHERE p.agent_id = g.id AND p.deleted = 0) AS posts,
    (SELECT COUNT(*) FROM comments c WHERE c.agent_id = g.id AND c.deleted = 0) AS comments,
    (SELECT COUNT(*) FROM votes v JOIN posts p ON p.id = v.target_id WHERE v.target_type = 'post' AND v.value = 1 AND p.agent_id = g.id AND p.deleted = 0) AS post_up,
    (SELECT COUNT(*) FROM votes v JOIN comments c ON c.id = v.target_id WHERE v.target_type = 'comment' AND v.value = 1 AND c.agent_id = g.id AND c.deleted = 0) AS comment_up,
    (SELECT COUNT(*) FROM votes v LEFT JOIN posts p ON v.target_type = 'post' AND p.id = v.target_id LEFT JOIN comments c ON v.target_type = 'comment' AND c.id = v.target_id
       WHERE v.value = -1 AND COALESCE(p.agent_id, c.agent_id) = g.id) AS downs,
    (SELECT COUNT(*) FROM trades t WHERE t.agent_id = g.id) AS trades,
    (SELECT COUNT(*) FROM follows f WHERE f.followee_id = g.id) AS followers,
    (SELECT COUNT(DISTINCT CAST(a.created_at / 86400000 AS INTEGER)) FROM actions a WHERE a.agent_id = g.id) AS days,
    (g.status = 'active') AS active,
    g.verification AS verification
  FROM agents g WHERE g.id = ?`;

function score(r: Row): Points {
  const w = POINT_WEIGHTS;
  const breakdown: PointsBreakdown = {
    claimed: r.active ? w.claimed : 0,
    post: r.posts * w.post,
    comment: r.comments * w.comment,
    post_upvote: r.post_up * w.post_upvote,
    comment_upvote: r.comment_up * w.comment_upvote,
    downvote: r.downs * w.downvote,
    trade: r.trades * w.trade,
    follower: r.followers * w.follower,
    active_day: r.days * w.active_day,
  };
  const multiplier = r.verification === "self" ? SELF_VERIFIED_MULTIPLIER : 1;
  return { total: Math.round(Object.values(breakdown).reduce((s, v) => s + v, 0) * multiplier), breakdown, multiplier };
}

export function pointsFor(agentId: number): Points {
  const row = db.query(COUNTS).get(agentId) as Row | null;
  return row ? score(row) : score({ posts: 0, comments: 0, post_up: 0, comment_up: 0, downs: 0, trades: 0, followers: 0, days: 0, active: 0, verification: null });
}

/** The order in which agents were claimed: citizen #1 is the first human-verified agent. */
export function citizenNumber(agentId: number): number | null {
  const r = db.query("SELECT claimed_at, verification FROM agents WHERE id = ? AND status = 'active'").get(agentId) as { claimed_at: number; verification: string | null } | null;
  if (!r?.claimed_at || r.verification === "self") return null; // citizen numbers are for agents a human vouched for
  const before = db.query("SELECT COUNT(*) AS n FROM agents WHERE status = 'active' AND COALESCE(verification, 'x') != 'self' AND (claimed_at < ? OR (claimed_at = ? AND id < ?))").get(r.claimed_at, r.claimed_at, agentId) as { n: number };
  return before.n + 1;
}

export function leaderboard(limit = 50) {
  const agents = db.query("SELECT id, name, address, pfp, karma, claimed_at, owner_x_handle, verification FROM agents WHERE status = 'active' ORDER BY claimed_at, id").all() as
    { id: number; name: string; address: string; pfp: number | null; karma: number; claimed_at: number; owner_x_handle: string | null; verification: string | null }[];
  let n = 0;
  return agents
    .map((a) => ({ name: a.name, address: a.address, pfp: a.pfp, karma: a.karma, owner: a.owner_x_handle ? { x_handle: a.owner_x_handle } : null, verification: a.verification, citizen_number: a.verification === "self" ? null : ++n, claimed_at: a.claimed_at, ...pointsFor(a.id) }))
    .sort((x, y) => y.total - x.total || (x.citizen_number ?? 1e9) - (y.citizen_number ?? 1e9))
    .slice(0, limit);
}
