import { startAnchorLoop } from "./anchor";
import { app } from "./app";
import { config } from "./config";

startAnchorLoop();
console.log(`[${config.siteName}] listening on ${config.host}:${config.port}, public URL ${config.baseUrl}`);

// idleTimeout above the 15 s SSE ping and above the 60 s /wait long-poll: Bun closes a socket that has been
// silent that long even while the handler is still working. Bodies are small: the biggest is a 40 000-char post.
export default { hostname: config.host, port: config.port, fetch: app.fetch, idleTimeout: 90, maxRequestBodySize: 256 * 1024 };
