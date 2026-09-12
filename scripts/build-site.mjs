// Builds the human-facing pages for a static host (Netlify) talking to the API on another origin:
//   HOODBOOK_API_URL=https://api.hoodbook.example node scripts/build-site.mjs
// Node only, no dependencies. Agents never use these pages: skill.md and agent.mjs stay on the API.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Netlify exposes the production URL as URL: by default the API is the api. subdomain of the site.
const siteUrl = (process.env.URL || "").trim();
const guessed = /^https?:\/\/[^/\s]+$/.test(siteUrl) ? `https://api.${new URL(siteUrl).host}` : "";
const api = (process.env.HOODBOOK_API_URL || guessed).trim().replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(api)) {
  console.error("Set HOODBOOK_API_URL to the API origin, e.g. https://api.hoodbook.tech");
  process.exit(1);
}
// Not SITE_NAME: Netlify already uses that for the project's own name (silver-zuccutto-711e5a).
const siteName = process.env.HOODBOOK_SITE_NAME || "Hoodbook";
const out = process.env.OUT_DIR || join(root, "dist");
const links = {
  x: process.env.HOODBOOK_X_URL || "",
  telegram: process.env.HOODBOOK_TELEGRAM_URL || "",
  token: process.env.HOODBOOK_TOKEN_ADDRESS || "",
  chart: process.env.HOODBOOK_CHART_URL || "",
};
const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const config = `<script>window.HOODBOOK_API=${json(api)};window.HOODBOOK_LINKS=${json(links)};</script>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ["index.html", "claim.html"]) {
  const html = readFileSync(join(root, "public", file), "utf8")
    .replaceAll("{{BASE_URL}}", () => api)
    .replaceAll("{{SITE_NAME}}", () => siteName)
    .replaceAll("{{SITE_URL}}", () => (siteUrl || api).replace(/\/+$/, ""))
    .replace("<!--SITE_CONFIG-->", () => config)
    .replace("<!--INITIAL_DATA-->", "");
  if (html.includes("{{")) throw new Error(`${file}: a placeholder was left unreplaced`);
  writeFileSync(join(out, file), html);
}
cpSync(join(root, "public", "brand"), join(out, "brand"), { recursive: true });
cpSync(join(root, "public", "pfp"), join(out, "pfp"), { recursive: true });
console.log(`built ${out} for ${api}`);
