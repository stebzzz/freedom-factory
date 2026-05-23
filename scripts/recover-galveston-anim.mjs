#!/usr/bin/env node
// recover-galveston-anim.mjs — recovery dédiée au test batch galveston (ids 1,8,22,29,37).
// Lit /tmp/galveston-test-videos.log pour récupérer le mapping {vid#id → taskId},
// GET /v2/veo/histories paginé, télécharge les completed dans clips/, liste les pending/failed.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const LOG_PATH = process.env.LOG_PATH || "/tmp/galveston-test-videos.log";
const PROMPTS_PATH = path.join(ROOT, "galveston_1900_prompts.json");
const OUT_DIR = path.join(ROOT, "public/generated/galveston_1900");
const CLIP_DIR = path.join(OUT_DIR, "clips");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "20000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || "1800000", 10);

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
function loadGenaiproKey() {
  const k = process.env.GENAIPRO_API_KEY || loadEnvLocal().GENAIPRO_API_KEY;
  if (!k) { console.error("GENAIPRO_API_KEY manquante"); process.exit(1); }
  return k;
}

function httpsRequest(method, urlPath, headers, body, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on("error", (err) => {
        if (n > 0) { console.warn(`[retry] ${err.code || err.message}`); setTimeout(() => attempt(n - 1), 5000); }
        else reject(err);
      });
      req.setTimeout(180_000, () => { req.destroy(); if (n > 0) attempt(n - 1); else reject(new Error("HTTP timeout")); });
      if (body) req.write(body);
      req.end();
    };
    attempt(retries);
  });
}

function rewriteCdnUrl(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}
function httpsDownload(url, retries = 3) {
  const target = rewriteCdnUrl(url);
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(target, { headers: { "User-Agent": "FreedomFactory/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return httpsDownload(res.headers.location, n).then(resolve).catch(reject);
        if (res.statusCode !== 200) {
          if (n > 0) { setTimeout(() => attempt(n - 1), 5000); return; }
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", (err) => {
        if (n > 0) { setTimeout(() => attempt(n - 1), 5000); }
        else reject(err);
      });
    };
    attempt(retries);
  });
}

function extFromUrl(u, fallback) {
  const m = u.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : fallback;
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

function parseLog(logPath) {
  const map = new Map(); // taskId -> id
  const text = readFileSync(logPath, "utf-8");
  for (const m of text.matchAll(/\[vid#(\d+)\] task ([0-9a-f-]{36})/g)) {
    map.set(m[2], parseInt(m[1], 10));
  }
  return map;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { entries: [] };
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}
function saveManifest(m) { writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }

async function pollByTaskIds(token, taskIds) {
  const pending = new Set(taskIds);
  const out = new Map();
  const start = Date.now();
  let cycle = 0, succeeded = 0, failed = 0;
  while (pending.size > 0) {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      console.log(`\n[poll] timeout. pending=${pending.size}`);
      break;
    }
    let page = 1;
    while (pending.size > 0) {
      const res = await httpsRequest("GET",
        `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`,
        { Authorization: `Bearer ${token}` });
      if (res.status !== 200) throw new Error(`histories ${res.status}`);
      const body = JSON.parse(res.body.toString("utf-8"));
      const items = body.data || [];
      for (const item of items) {
        if (!pending.has(item.id)) continue;
        if (item.status === "completed") { out.set(item.id, item); pending.delete(item.id); succeeded++; }
        else if (item.status === "failed") { out.set(item.id, item); pending.delete(item.id); failed++; }
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages || items.length === 0) break;
      page++;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[poll] ok=${succeeded} fail=${failed} pending=${pending.size} (${elapsed}s, cycle ${++cycle})        `);
    if (pending.size === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");
  return out;
}

async function main() {
  mkdirSync(CLIP_DIR, { recursive: true });
  const token = loadGenaiproKey();
  const spec = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const sceneById = new Map(spec.scenes.map((s) => [s.id, s]));
  const manifest = loadManifest();

  const taskMap = parseLog(LOG_PATH); // taskId -> id
  console.log(`Recovery galveston: ${taskMap.size} task(s) à vérifier`);
  for (const [tid, id] of taskMap) console.log(`  vid#${id} ${tid}`);

  const histories = await pollByTaskIds(token, [...taskMap.keys()]);

  const downloaded = [], failedN = [], stuckN = [];
  for (const [taskId, id] of taskMap) {
    const r = histories.get(taskId);
    const scene = sceneById.get(id) || { section: `id_${id}` };
    if (!r) { stuckN.push(id); continue; }
    if (r.status === "failed") { console.log(`FAIL id ${id}: ${r.error || ""}`); failedN.push(id); continue; }
    if (r.status !== "completed") { stuckN.push(id); continue; }
    const url = r.file_urls?.[0];
    if (!url) { failedN.push(id); continue; }
    try {
      const buf = await httpsDownload(url);
      const ext = extFromUrl(url, "mp4");
      const fname = `${String(id).padStart(2, "0")}_${slug(scene.section)}.${ext}`;
      const fpath = path.join(CLIP_DIR, fname);
      await writeFile(fpath, buf);
      console.log(`OK id ${id} -> ${fname} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      const entry = manifest.entries.find((e) => e.id === id);
      if (entry) entry.video = { taskId, url, path: fpath };
      else manifest.entries.push({ id, section: scene.section, video: { taskId, url, path: fpath } });
      saveManifest(manifest);
      downloaded.push(id);
    } catch (e) {
      console.log(`DL FAIL id ${id}: ${e.message}`);
      failedN.push(id);
    }
  }

  console.log("\n=== RECAP RECOVERY ===");
  console.log(`OK (${downloaded.length}): ${downloaded.sort((a, b) => a - b).join(", ") || "—"}`);
  if (failedN.length) console.log(`FAILED (${failedN.length}, à re-POST): ${failedN.sort((a, b) => a - b).join(", ")}`);
  if (stuckN.length) console.log(`STILL PENDING (${stuckN.length}): ${stuckN.sort((a, b) => a - b).join(", ")}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
