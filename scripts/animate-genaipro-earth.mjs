#!/usr/bin/env node
// animate-genaipro-earth.mjs — anime toutes les images de
//   public/generated/earth_evolution_genaipro/images/
// via GenAIPro Veo V2 frames-to-video, en utilisant les video_prompt de
// earth_evolution_prompts.json. Skip auto les rows déjà présentes dans clips/.
//
// Usage :
//   node scripts/animate-genaipro-earth.mjs                  # toutes les rows manquantes
//   ROWS=2,6,11 node scripts/animate-genaipro-earth.mjs      # sous-ensemble
//   FORCE=1 node scripts/animate-genaipro-earth.mjs          # ré-anime même si clip présent
//   CONCURRENCY=10 RATE_PER_MIN=25 POLL_INTERVAL_MS=15000    # overrides
//
// Pattern recopié de scripts/test-genaipro-earth.mjs (multipart, polling collectif
// /v2/veo/histories, CDN rewrite files.genaipro.vn → genaipro.io/files/).

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROMPTS_PATH = path.join(ROOT, "earth_evolution_prompts.json");
const OUT_DIR = path.join(ROOT, "public/generated/earth_evolution_genaipro");
const IMG_DIR = path.join(OUT_DIR, "images");
const CLIP_DIR = path.join(OUT_DIR, "clips");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ASPECT_VID = "VIDEO_ASPECT_RATIO_LANDSCAPE";

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10", 10);
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || "25", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || "1800000", 10); // 30 min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pLimit(concurrency) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= concurrency || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { running--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function makeRateLimiter(perMinute) {
  const interval = 60_000 / perMinute;
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = last + interval - now;
    if (wait > 0) await sleep(wait);
    last = Math.max(now, last + interval);
  };
}

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
  if (!k) {
    console.error("GENAIPRO_API_KEY manquante (ajoute-la dans .env.local)");
    process.exit(1);
  }
  return k;
}

function buildMultipart(fields) {
  const boundary = `----GenAIPro${randomBytes(8).toString("hex")}`;
  const parts = [];
  for (const [name, value] of fields) {
    if (value && typeof value === "object" && value.filename) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n` +
        `Content-Type: ${value.contentType}\r\n\r\n`
      ));
      parts.push(value.buffer);
      parts.push(Buffer.from("\r\n"));
    } else {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function httpsRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(180_000, () => { req.destroy(); reject(new Error(`HTTP ${method} timeout`)); });
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

function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
    return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { ext: "png", mime: "image/png" };
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
    return { ext: "webp", mime: "image/webp" };
  return { ext: "bin", mime: "application/octet-stream" };
}
function extFromUrl(u, fallback) {
  const m = u.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : fallback;
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

async function framesToVideo(token, imageBuffer, imageName, prompt) {
  const detected = detectImageType(imageBuffer);
  const baseName = imageName.replace(/\.[^.]+$/, "");
  const properName = `${baseName}.${detected.ext}`;
  const { body, contentType } = buildMultipart([
    ["start_image", { filename: properName, contentType: detected.mime, buffer: imageBuffer }],
    ["prompt", prompt],
    ["aspect_ratio", ASPECT_VID],
    ["number_of_videos", "1"],
  ]);
  const res = await httpsRequest("POST", `${API_BASE}/v2/veo/frames-to-video`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "Content-Length": body.length,
  }, body);
  if (res.status !== 202) {
    throw new Error(`frames-to-video ${res.status}: ${res.body.toString("utf-8").slice(0, 500)}`);
  }
  const data = JSON.parse(res.body.toString("utf-8"));
  const history = data.histories?.[0];
  if (!history) throw new Error("frames-to-video: no history in response");
  return history;
}

async function pollHistoriesUntilDone(token, taskIds, label) {
  const pending = new Set(taskIds);
  const results = new Map();
  const start = Date.now();
  let succeeded = 0, failed = 0, cycle = 0;
  while (pending.size > 0) {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      process.stdout.write(`\n[${label}] poll timeout (${POLL_TIMEOUT_MS / 1000}s). pending: ${[...pending].map((id) => id.slice(0, 8)).join(", ")}\n`);
      break;
    }
    let page = 1;
    while (pending.size > 0) {
      const res = await httpsRequest("GET",
        `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`,
        { Authorization: `Bearer ${token}` });
      if (res.status !== 200) {
        throw new Error(`[${label}] histories ${res.status}: ${res.body.toString("utf-8").slice(0, 300)}`);
      }
      const body = JSON.parse(res.body.toString("utf-8"));
      const items = body.data || [];
      for (const item of items) {
        if (!pending.has(item.id)) continue;
        if (item.status === "completed") { results.set(item.id, item); pending.delete(item.id); succeeded++; }
        else if (item.status === "failed") { results.set(item.id, item); pending.delete(item.id); failed++; }
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages) break;
      if (items.length === 0) break;
      page++;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[${label}] ok=${succeeded} fail=${failed} pending=${pending.size} (${elapsed}s, cycle ${++cycle})        `);
    if (pending.size === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");
  return results;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { entries: [] };
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}
function saveManifest(m) { writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }

function listExistingClipRows() {
  if (!existsSync(CLIP_DIR)) return new Set();
  const out = new Set();
  for (const f of readdirSync(CLIP_DIR)) {
    const m = f.match(/^(\d+)_/);
    if (m) out.add(parseInt(m[1], 10));
  }
  return out;
}
function listImagesByRow() {
  const map = new Map();
  for (const f of readdirSync(IMG_DIR)) {
    const m = f.match(/^(\d+)_.+\.(png|jpg|jpeg|webp)$/i);
    if (m) map.set(parseInt(m[1], 10), path.join(IMG_DIR, f));
  }
  return map;
}

async function main() {
  if (!existsSync(IMG_DIR)) throw new Error(`IMG_DIR introuvable: ${IMG_DIR}`);
  mkdirSync(CLIP_DIR, { recursive: true });
  const token = loadGenaiproKey();
  const prompts = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const imagesByRow = listImagesByRow();
  const existingClips = listExistingClipRows();
  const force = !!process.env.FORCE;

  let wanted;
  if (process.env.ROWS) {
    wanted = process.env.ROWS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  } else {
    wanted = [...imagesByRow.keys()].sort((a, b) => a - b);
  }

  const queue = [];
  const skipped = [];
  for (const n of wanted) {
    const imgPath = imagesByRow.get(n);
    if (!imgPath) { console.warn(`[skip] row ${n}: pas d'image dans ${path.relative(ROOT, IMG_DIR)}`); continue; }
    const row = prompts.find((p) => p.n === n);
    if (!row) { console.warn(`[skip] row ${n}: pas dans ${path.relative(ROOT, PROMPTS_PATH)}`); continue; }
    if (!row.video_prompt) { console.warn(`[skip] row ${n}: video_prompt vide`); continue; }
    if (!force && existingClips.has(n)) { skipped.push(n); continue; }
    queue.push({ n, epoch: row.epoch, videoPrompt: row.video_prompt, imagePath: imgPath });
  }

  if (skipped.length) console.log(`[skip] clips déjà présents: ${skipped.join(", ")}`);
  if (!queue.length) { console.log("Rien à animer."); return; }

  console.log(`Animation: ${queue.length} row(s) (concurrency=${CONCURRENCY}, rate=${RATE_PER_MIN}/min, poll=${POLL_INTERVAL_MS}ms)`);
  console.log(`Rows: ${queue.map((q) => q.n).join(", ")}`);

  const manifest = loadManifest();
  const limit = pLimit(CONCURRENCY);
  const dlLimit = pLimit(5);
  const acquireRate = makeRateLimiter(RATE_PER_MIN);

  // Phase POST
  const t0 = Date.now();
  const submitted = await Promise.all(queue.map((q) => limit(async () => {
    await acquireRate();
    try {
      const buf = await readFile(q.imagePath);
      const history = await framesToVideo(token, buf, path.basename(q.imagePath), q.videoPrompt);
      console.log(`[vid#${q.n}] task ${history.id}`);
      return { ...q, taskId: history.id };
    } catch (e) {
      console.error(`[vid#${q.n}] POST échec: ${e.message}`);
      return { ...q, taskId: null, error: e.message };
    }
  })));
  const valid = submitted.filter((s) => s.taskId);
  if (!valid.length) throw new Error("Aucun POST frames-to-video accepté");
  console.log(`POST OK: ${valid.length}/${queue.length} en ${Math.round((Date.now() - t0) / 1000)}s`);

  // Polling
  const taskMap = new Map(valid.map((v) => [v.taskId, v]));
  const results = await pollHistoriesUntilDone(token, [...taskMap.keys()], "vid-poll");

  // Download
  const downloaded = [], failedN = [], stuckN = [];
  await Promise.all([...taskMap.entries()].map(([taskId, q]) => dlLimit(async () => {
    const r = results.get(taskId);
    if (!r) { stuckN.push(q.n); return; }
    if (r.status === "failed") { failedN.push(q.n); return; }
    if (r.status !== "completed") { stuckN.push(q.n); return; }
    const url = r.file_urls?.[0];
    if (!url) { failedN.push(q.n); return; }
    try {
      const buf = await httpsDownload(url);
      const ext = extFromUrl(url, "mp4");
      const fname = `${String(q.n).padStart(2, "0")}_${slug(q.epoch)}.${ext}`;
      const fpath = path.join(CLIP_DIR, fname);
      await writeFile(fpath, buf);
      console.log(`OK vid#${q.n} -> ${path.relative(ROOT, fpath)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      const entry = manifest.entries.find((e) => e.n === q.n);
      if (entry) {
        entry.video = { taskId, url, path: fpath };
      } else {
        manifest.entries.push({ n: q.n, epoch: q.epoch, video: { taskId, url, path: fpath } });
      }
      saveManifest(manifest);
      downloaded.push(q.n);
    } catch (e) {
      console.error(`[vid#${q.n}] DL échec: ${e.message}`);
      failedN.push(q.n);
    }
  })));

  console.log("\n=== RECAP ===");
  console.log(`OK (${downloaded.length}): ${downloaded.sort((a, b) => a - b).join(", ") || "—"}`);
  if (failedN.length) console.log(`FAILED côté Veo (${failedN.length}, crédits remboursés): ${failedN.sort((a, b) => a - b).join(", ")}`);
  if (stuckN.length) console.log(`TIMEOUT (${stuckN.length}): ${stuckN.sort((a, b) => a - b).join(", ")}`);
  console.log(`Manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
