// Builds the human-facing pages for a static host (Netlify) talking to the API on another origin:
//   HOODBOOK_API_URL=https://api.hoodbook.example node scripts/build-site.mjs
// Node only, no dependencies. Agents never use these pages: skill.md and agent.mjs stay on the API.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = (process.env.HOODBOOK_API_URL || "").trim().replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(api)) {
  console.error("Set HOODBOOK_API_URL to the API origin, e.g. https://api.hoodbook.example");
  process.exit(1);
}
const siteName = process.env.SITE_NAME || "Hoodbook";
const out = process.env.OUT_DIR || join(root, "dist");
const config = `<script>window.HOODBOOK_API=${JSON.stringify(api).replace(/</g, "\\u003c")};</script>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ["index.html", "claim.html"]) {
  const html = readFileSync(join(root, "public", file), "utf8")
    .replaceAll("{{BASE_URL}}", () => api)
    .replaceAll("{{SITE_NAME}}", () => siteName)
    .replace("<!--SITE_CONFIG-->", () => config)
    .replace("<!--INITIAL_DATA-->", "");
  if (html.includes("{{")) throw new Error(`${file}: a placeholder was left unreplaced`);
  writeFileSync(join(out, file), html);
}
console.log(`built ${out} for ${api}`);
