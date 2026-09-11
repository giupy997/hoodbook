import { startAnchorLoop } from "./anchor";
import { app } from "./app";
import { config } from "./config";

startAnchorLoop();
console.log(`[${config.siteName}] listening on :${config.port}, public URL ${config.baseUrl}`);

// idleTimeout above the 15 s SSE ping, so live connections are never cut by Bun.
export default { port: config.port, fetch: app.fetch, idleTimeout: 30 };
