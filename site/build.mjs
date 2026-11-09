// Santralio sitesi: derleme. src/*.html -> dist/ (Tailwind derlenmiş CSS, lucide ikonları satır içi SVG, CDN yok).
// Turnstile site anahtarı ortamdan (TURNSTILE_SITE_KEY; /etc/santralio/site.env) gelir; açık anahtardır.
// Vozyy adresi: VOZYY_API_BASE + /api/santralio (sunucudaki kontrol servisiyle aynı ayar).
// /basvuru, ana sayfanın kopyasıdır (sayfa açılınca kayıt formuna gider).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const DIST = "dist";
const ICONS = "node_modules/lucide-static/icons";
// lucide 0.460'ta yeniden adlandırılan ikonlar.
const ALIASES = { "check-circle-2": "circle-check", "bar-chart-3": "chart-column", "play-circle": "circle-play" };

const turnstile = process.env.TURNSTILE_SITE_KEY ?? "";
if (!/^[0-9A-Za-z_-]*$/.test(turnstile)) throw new Error("TURNSTILE_SITE_KEY geçersiz");
const vozyyBase = (process.env.VOZYY_API_BASE || "https://api.vozyy.com/license").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+(\/[a-z0-9_-]+)*$/i.test(vozyyBase)) throw new Error("VOZYY_API_BASE geçersiz");
const vozyyApi = `${vozyyBase}/api/santralio`;
if (!turnstile) console.warn("uyarı: TURNSTILE_SITE_KEY boş; kayıt formu robot doğrulaması olmadan gönderilemez");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "assets"), { recursive: true });

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const icon = (name, cls) => {
  const file = join(ICONS, `${ALIASES[name] ?? name}.svg`);
  const svg = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->\s*/, "").replace(/\s*\n\s*/g, " ").trim();
  return svg.replace(/class="([^"]*)"/, (_m, c) => `class="${c} ${escape(cls)}" aria-hidden="true" focusable="false"`);
};

execFileSync("node_modules/.bin/tailwindcss", ["-c", "tailwind.config.cjs", "-i", join(SRC, "site.css"), "-o", join(DIST, "assets", "site.css"), "--minify"], {
  stdio: "inherit",
});
const cssHash = createHash("sha256").update(readFileSync(join(DIST, "assets", "site.css"))).digest("hex").slice(0, 12);

for (const page of readdirSync(SRC).filter((f) => f.endsWith(".html"))) {
  let html = readFileSync(join(SRC, page), "utf8");
  html = html.replace(/<i data-lucide="([a-z0-9-]+)"(?: class="([^"]*)")?><\/i>/g, (_m, name, cls = "") => icon(name, cls));
  if (/data-lucide=/.test(html)) throw new Error(`${page}: çevrilemeyen ikon kaldı`);
  html = html.replaceAll("@SITE_CSS_HASH@", cssHash).replaceAll("@TURNSTILE_SITE_KEY@", turnstile).replaceAll("@VOZYY_SANTRALIO_API@", vozyyApi);
  for (const cdn of ["cdn.tailwindcss.com", "unpkg.com/lucide", "cdn.jsdelivr.net/npm/lucide"]) {
    if (html.includes(cdn)) throw new Error(`${page}: CDN kaldı: ${cdn}`);
  }
  writeFileSync(join(DIST, page), html);
  if (page === "index.html") writeFileSync(join(DIST, "basvuru.html"), html);
}
console.log(`site derlendi: ${readdirSync(DIST).join(", ")} (css ${cssHash})`);
