#!/usr/bin/env node
// sticky-fetch-ready.mjs — utilitaire one-shot qui lit pending.json,
// poll /v2/veo/histories, et telecharge toutes les images `completed`
// pas encore presentes en local. Tourne EN PARALLELE du script principal
// sans interferer (lock-free, idempotent).
//
// Usage :
//   PROJECT_SLUG=sticky_infantile_amnesia node scripts/sticky-fetch-ready.mjs

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { writeFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROJECT_SLUG = process.env.PROJECT_SLUG || "sticky_infantile_amnesia";
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_SLUG);
const IMG_DIR = path.join(OUT_DIR, "images");
const PENDING_PATH = path.join(OUT_DIR, "pending.json");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const API_HOST = "genaipro.io";
const API_BASE = "/api";

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
function loadToken() {
  const env = loadEnvLocal();
  const k = process.env.GENAIPRO_API_KEY || env.GENAIPRO_API_KEY || env.GENAIPRO_TOKEN;
  if (!k) { console.error("GENAIPRO_API_KEY manquante (.env.local)"); process.exit(1); }
  return k;
}

function httpsRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error(`HTTP ${method} timeout`)); });
    if (body) req.write(body);
    req.end();
  });
}

function rewriteCdnUrl(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}
function httpsDownload(url) {
  const target = rewriteCdnUrl(url);
  return new Promise((resolve, reject) => {
    https.get(target, { headers: { "User-Agent": "FreedomFactory/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${target}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function extFromUrl(u, fallback) {
  const m = u.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : fallback;
}

function loadPending() {
  if (!existsSync(PENDING_PATH)) return {};
  try { return JSON.parse(readFileSync(PENDING_PATH, "utf-8")); } catch { return {}; }
}
function savePending(p) { writeFileSync(PENDING_PATH, JSON.stringify(p, null, 2)); }
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { entries: [] };
  try { return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")); } catch { return { entries: [] }; }
}
function saveManifest(m) { writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }

function existingRows() {
  if (!existsSync(IMG_DIR)) return new Set();
  const out = new Set();
  for (const f of readdirSync(IMG_DIR)) {
    const m = f.match(/^(\d+)_/);
    if (m) out.add(parseInt(m[1], 10));
  }
  return out;
}

async function main() {
  mkdirSync(IMG_DIR, { recursive: true });
  const token = loadToken();
  const pending = loadPending();
  const taskIds = Object.keys(pending);
  if (taskIds.length === 0) { console.log("pending.json vide — rien a rapatrier."); return; }

  const haveLocally = existingRows();
  const toFetch = new Map(); // taskId -> { n }
  for (const [id, meta] of Object.entries(pending)) {
    if (haveLocally.has(meta.n)) {
      delete pending[id]; continue; // sanity cleanup
    }
    toFetch.set(id, meta);
  }
  savePending(pending);
  if (toFetch.size === 0) { console.log("Tout ce qui est dans pending est deja en local. Cleanup applique."); return; }

  console.log(`A surveiller: ${toFetch.size} tasks (n = ${[...toFetch.values()].map((v) => v.n).sort((a, b) => a - b).join(",")})`);

  const manifest = loadManifest();
  let downloaded = 0, failed = 0;

  // Pagination des histories — on s'arrete des qu'on a vu tout pending.
  let page = 1;
  const seen = new Set();
  while (toFetch.size > 0) {
    const res = await httpsRequest("GET",
      `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`,
      { Authorization: `Bearer ${token}` });
    if (res.status !== 200) {
      console.error(`histories ${res.status}: ${res.body.toString("utf-8").slice(0, 200)}`);
      break;
    }
    const body = JSON.parse(res.body.toString("utf-8"));
    const items = body.data || [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (!toFetch.has(item.id)) continue;
      const meta = toFetch.get(item.id);
      if (item.status === "completed") {
        const url = item.file_urls?.[0];
        if (!url) { console.error(`img#${meta.n}: pas de file_urls`); failed++; toFetch.delete(item.id); continue; }
        try {
          const buf = await httpsDownload(url);
          const ext = extFromUrl(url, "png");
          const fname = `${String(meta.n).padStart(3, "0")}_img.${ext}`;
          const fpath = path.join(IMG_DIR, fname);
          await writeFile(fpath, buf);
          console.log(`OK img#${meta.n} -> ${path.relative(ROOT, fpath)} (${(buf.length / 1024).toFixed(0)} KB)`);
          const entry = manifest.entries.find((e) => e.n === meta.n);
          if (entry) entry.image = { taskId: item.id, url, path: fpath };
          else manifest.entries.push({ n: meta.n, image: { taskId: item.id, url, path: fpath } });
          saveManifest(manifest);
          delete pending[item.id]; savePending(pending);
          toFetch.delete(item.id);
          downloaded++;
        } catch (e) {
          console.error(`img#${meta.n} DL echec: ${e.message}`); failed++;
        }
      } else if (item.status === "failed") {
        console.error(`FAIL cote Veo img#${meta.n} (credits rembourses)`);
        delete pending[item.id]; savePending(pending);
        toFetch.delete(item.id);
        failed++;
      }
      // else: still pending / running — leave it
    }
    const totalPages = body.total_pages ?? 1;
    if (page >= totalPages) break;
    if (items.length === 0) break;
    page++;
  }

  const stillWaiting = toFetch.size;
  console.log(`\n=== FETCH RECAP ===`);
  console.log(`Downloaded: ${downloaded}`);
  if (failed) console.log(`Failed: ${failed}`);
  if (stillWaiting) {
    const stuck = [...toFetch.values()].map((v) => v.n).sort((a, b) => a - b);
    console.log(`Encore en generation cote Veo (${stillWaiting}): ${stuck.join(", ")}`);
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
