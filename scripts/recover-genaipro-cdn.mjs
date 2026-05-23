#!/usr/bin/env node
// recover-genaipro-cdn.mjs — récupère les images earth_evolution depuis l'historique GenAIPro
// après migration files.genaipro.vn → genaipro.io/files/. Phase 1 only (images).
//
// Usage : node scripts/recover-genaipro-cdn.mjs

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROMPTS_PATH = path.join(ROOT, "earth_evolution_prompts.json");
const OUT_DIR = path.join(ROOT, "public/generated/earth_evolution_genaipro");
const IMG_DIR = path.join(OUT_DIR, "images");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const API_HOST = "genaipro.io";
const CDN_HOST = "genaipro.io";
const CDN_PATH_PREFIX = "/files/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!existsSync(p)) return {};
  const o = {};
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return o;
}
function loadKey() {
  const k = process.env.GENAIPRO_API_KEY || loadEnvLocal().GENAIPRO_API_KEY;
  if (!k) { console.error("GENAIPRO_API_KEY manquante"); process.exit(1); }
  return k;
}

function httpsGet(host, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: host, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}
function rewriteCdnUrl(url) {
  // Old: https://files.genaipro.vn/<file>
  // New: https://genaipro.io/files/<file>
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  if (m) return `https://${CDN_HOST}${CDN_PATH_PREFIX}${m[1]}`;
  return url;
}
function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
    return { ext: "jpg" };
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { ext: "png" };
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
    return { ext: "webp" };
  return { ext: "bin" };
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

async function fetchAllHistory(token) {
  const all = [];
  for (let pg = 1; pg <= 30; pg++) {
    const r = await httpsGet(API_HOST, `/api/v2/veo/histories?page=${pg}&page_size=100`, {
      Authorization: `Bearer ${token}`,
    });
    if (r.status !== 200) throw new Error(`histories ${r.status}: ${r.body.toString().slice(0, 200)}`);
    const j = JSON.parse(r.body.toString());
    all.push(...(j.data || []));
    if (pg >= (j.total_pages || 1)) break;
  }
  return all;
}

async function downloadOne(url) {
  const u = rewriteCdnUrl(url);
  const m = u.match(/^https?:\/\/([^\/]+)(\/.*)$/);
  if (!m) throw new Error("bad url: " + u);
  const r = await httpsGet(m[1], m[2]);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.body;
}

async function main() {
  mkdirSync(IMG_DIR, { recursive: true });
  const token = loadKey();
  const prompts = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const onDisk = new Set(
    readdirSync(IMG_DIR).filter((f) => /^\d+_/.test(f)).map((f) => parseInt(f.split("_")[0], 10))
  );
  const missing = prompts.filter((p) => !onDisk.has(p.n));
  console.log(`[recover] ${onDisk.size} images sur disque, ${missing.length} manquantes`);

  console.log(`[recover] Fetch historique...`);
  const history = await fetchAllHistory(token);
  console.log(`[recover] ${history.length} items dans l'historique`);

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))
    : { entries: [] };

  const recovered = [], stillMissing = [];
  for (const p of missing) {
    const target = norm(p.image_prompt);
    const matches = history
      .filter((h) => h.status === "completed" && h.file_urls?.[0] && norm(h.prompt) === target)
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    if (!matches.length) { stillMissing.push(p.n); continue; }
    const m = matches[0];
    try {
      const buf = await downloadOne(m.file_urls[0]);
      const ext = detectImageType(buf).ext === "bin" ? "png" : detectImageType(buf).ext;
      const fname = `${String(p.n).padStart(2, "0")}_${slug(p.epoch)}.${ext}`;
      const fpath = path.join(IMG_DIR, fname);
      await writeFile(fpath, buf);
      console.log(`OK row ${p.n} -> ${fname} (${(buf.length / 1024).toFixed(0)} KB)`);
      const existing = manifest.entries.find((e) => e.n === p.n);
      const entry = existing || { n: p.n, epoch: p.epoch };
      entry.image = { taskId: m.id, url: rewriteCdnUrl(m.file_urls[0]), path: fpath };
      if (!existing) manifest.entries.push(entry);
      writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
      recovered.push(p.n);
    } catch (e) {
      console.error(`FAIL row ${p.n}: ${e.message}`);
      stillMissing.push(p.n);
    }
  }
  console.log(`\n=== RECOVERY DONE ===`);
  console.log(`Recovered (${recovered.length}): ${recovered.join(", ")}`);
  console.log(`Still missing (${stillMissing.length}): ${stillMissing.join(", ")}`);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
