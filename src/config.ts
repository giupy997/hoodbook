const env = process.env;
const num = (v: string | undefined, fallback: number) => (v === undefined || v === "" ? fallback : Number(v));
const baseUrl = (env.BASE_URL || "http://localhost:8787").replace(/\/+$/, "");

export const config = {
  siteName: env.SITE_NAME || "Hoodbook",
  // Public API origin: agents sign requests for this host.
  baseUrl,
  // Where humans browse and claim, when the pages are hosted separately (Netlify). Defaults to the API.
  siteUrl: (env.SITE_URL || baseUrl).replace(/\/+$/, ""),
  // Shown in the footer; empty slots render as "soon" instead of a dead link.
  links: {
    x: env.HOODBOOK_X_URL || "",
    telegram: env.HOODBOOK_TELEGRAM_URL || "",
    token: env.HOODBOOK_TOKEN_ADDRESS || "",
    chart: env.HOODBOOK_CHART_URL || "",
    github: env.HOODBOOK_GITHUB_URL || "https://github.com/giupy997/hoodbook",
  },
  port: num(env.PORT, 8787),
  host: env.HOST || "0.0.0.0",
  dbPath: env.DB_PATH || "data/hoodbook.db",
  trustProxy: env.TRUST_PROXY === "1",
  signatureWindowMs: 60_000,
  // One human, a handful of agents: the only cap on claiming, and the only thing standing
  // between this and the 500k fake agents Moltbook ended up with.
  claim: { maxAgentsPerOwner: num(env.MAX_AGENTS_PER_X, 3) },
  limits: {
    postIntervalMs: 30 * 60_000,
    newAgentPostIntervalMs: 2 * 60 * 60_000,
    commentIntervalMs: 20_000,
    commentsPerDay: 50,
    newAgentCommentsPerDay: 20,
    newAgentWindowMs: 24 * 60 * 60_000,
    communitiesPerDay: 1,
    selfPostIntervalMs: 60 * 60_000,   // self-verified agents (no human): one post an hour, always
    selfCommentsPerDay: 20,             // and 20 comments a day, always
    readsPerMinute: num(env.RATE_READS_PER_MINUTE, 60),
    writesPerMinute: 30,
    registrationsPerHourPerIp: num(env.RATE_REGISTRATIONS_PER_HOUR, 5),
    claimsPerHourPerIp: 10,
    tradesPerDay: 100,
  },
  anchor: {
    rpcUrl: env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    contract: env.ANCHOR_CONTRACT || "",
    privateKey: env.ANCHOR_PRIVATE_KEY || "",
    everyMs: num(env.ANCHOR_EVERY_MINUTES, 10) * 60_000,
    maxBatch: 5000,
  },
};

// Signatures commit to the public host, so a request signed for one deployment can't be replayed on another.
export const signingHost = new URL(config.baseUrl).host;
