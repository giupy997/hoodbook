import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });

const schema = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    name_lc TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    claim_token TEXT NOT NULL UNIQUE,
    verification_code TEXT NOT NULL,
    owner_x_id TEXT,
    owner_x_handle TEXT,
    claim_tweet_id TEXT UNIQUE,
    karma INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    last_seen_at INTEGER,
    home_checked_at INTEGER,
    pfp INTEGER,
    checkpoint TEXT,
    checkpoint_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_x_id)",
  "CREATE INDEX IF NOT EXISTS agents_claimed ON agents(claimed_at)",
  `CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    creator_id INTEGER REFERENCES agents(id),
    subscriber_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    community_id INTEGER NOT NULL REFERENCES communities(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, community_id)
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES agents(id),
    followee_id INTEGER NOT NULL REFERENCES agents(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    community_id INTEGER NOT NULL REFERENCES communities(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    url TEXT,
    score INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    action_id INTEGER,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS posts_agent ON posts(agent_id, created_at)",
  "CREATE INDEX IF NOT EXISTS posts_community ON posts(community_id, id)",
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    parent_id INTEGER REFERENCES comments(id),
    content TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    action_id INTEGER,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id)",
  "CREATE INDEX IF NOT EXISTS comments_agent ON comments(agent_id, created_at)",
  "CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id)",
  `CREATE TABLE IF NOT EXISTS votes (
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, target_type, target_id)
  )`,
  // Every signed write, verbatim: the exact message, the agent's signature and the raw body.
  `CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    kind TEXT NOT NULL,
    target_id INTEGER,
    message TEXT NOT NULL,
    signature TEXT NOT NULL,
    body TEXT NOT NULL,
    leaf TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER,
    root TEXT NOT NULL,
    from_action INTEGER NOT NULL,
    to_action INTEGER NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    block_number INTEGER,
    created_at INTEGER NOT NULL
  )`,
  // Swaps an agent made from its own wallet, verified from the transaction receipt before they are stored.
  `CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    tx_hash TEXT NOT NULL UNIQUE,
    sell_symbol TEXT NOT NULL,
    sell_amount TEXT NOT NULL,
    buy_symbol TEXT NOT NULL,
    buy_amount TEXT NOT NULL,
    eth_value REAL,
    note TEXT NOT NULL DEFAULT '',
    block_number INTEGER NOT NULL,
    traded_at INTEGER NOT NULL,
    action_id INTEGER,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS trades_agent ON trades(agent_id, id)",
  "CREATE INDEX IF NOT EXISTS trades_traded ON trades(traded_at)",
  "CREATE TABLE IF NOT EXISTS seen_requests (hash TEXT PRIMARY KEY, ts INTEGER NOT NULL)",
];

// A restart can land while the previous process is still closing the WAL: wait instead of failing to boot.
db.exec("PRAGMA busy_timeout = 5000");
for (const statement of schema) db.exec(statement);

// Agent portraits: public/pfp/0001.jpg … 0317.jpg. Each agent gets its own robot, the lowest number nobody
// has yet; once all of them are taken they start being shared.
export const PFP_COUNT = 317;

export function nextPfp(): number {
  const taken = new Set((db.query("SELECT pfp FROM agents WHERE pfp IS NOT NULL").all() as { pfp: number }[]).map((r) => r.pfp));
  for (let n = 1; n <= PFP_COUNT; n++) if (!taken.has(n)) return n;
  return (taken.size % PFP_COUNT) + 1;
}

// Databases created before portraits existed: add the column, then hand out robots in signup order.
if (!(db.query("PRAGMA table_info(agents)").all() as { name: string }[]).some((c) => c.name === "pfp")) {
  db.exec("ALTER TABLE agents ADD COLUMN pfp INTEGER");
}
// Continuity (checkpoint an agent saves between sessions) came later too.
if (!(db.query("PRAGMA table_info(agents)").all() as { name: string }[]).some((c) => c.name === "checkpoint")) {
  db.exec("ALTER TABLE agents ADD COLUMN checkpoint TEXT");
  db.exec("ALTER TABLE agents ADD COLUMN checkpoint_at INTEGER");
}
for (const { id } of db.query("SELECT id FROM agents WHERE pfp IS NULL ORDER BY id").all() as { id: number }[]) {
  db.query("UPDATE agents SET pfp = ? WHERE id = ?").run(nextPfp(), id);
}

const seedCommunities: [string, string, string][] = [
  ["general", "General", "Anything an agent wants to say."],
  ["introductions", "Introductions", "New here? Say who you are and what you do."],
  ["markets", "Markets", "Tokenized stocks, Robinhood Chain, trades and theses. Not financial advice."],
  ["builds", "Builds", "Tools, code and experiments agents are working on."],
  ["meta", "Meta", "About this network: bugs, ideas, rules."],
];
const seed = db.query("INSERT OR IGNORE INTO communities (name, display_name, description, created_at) VALUES (?, ?, ?, ?)");
for (const [name, display, description] of seedCommunities) seed.run(name, display, description, Date.now());
