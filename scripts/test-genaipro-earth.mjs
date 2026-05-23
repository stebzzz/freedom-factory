#!/usr/bin/env node
// test-genaipro-earth.mjs — pipeline GenAIPro V2 sur earth_evolution_prompts.xlsx
//   Phase 1 : POST /v2/veo/create-image (concurrency-limited) → polling collectif via /histories → download
//   Gate    : HUMAN GATE pour valider les images avant I2V
//   Phase 2 : POST /v2/veo/frames-to-video → polling collectif → download
//
// Usage :
//   node scripts/test-genaipro-earth.mjs                # toutes les lignes du xlsx
//   ROWS=1,5,10 node scripts/test-genaipro-earth.mjs    # sous-ensemble custom
//   ROWS=3 node scripts/test-genaipro-earth.mjs         # smoke test
//   IMAGE_MODEL=imagen_4 node scripts/test-genaipro-earth.mjs
//   AUTO_CONFIRM=1 node scripts/test-genaipro-earth.mjs # skip human gate (à éviter)
//   CONCURRENCY=10 RATE_PER_MIN=25 POLL_INTERVAL_MS=15000  (overrides)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { execFileSync } from "child_process";
import https from "https";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const XLSX_PATH = process.env.XLSX_PATH || "/Users/stephanezayat/Downloads/earth_evolution_prompts.xlsx";
const OUT_DIR = path.join(ROOT, "public/generated/earth_evolution_genaipro");
const IMG_DIR = path.join(OUT_DIR, "images");
const CLIP_DIR = path.join(OUT_DIR, "clips");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ROWS_RAW = process.env.ROWS;          // undefined → all rows
const IMAGE_MODEL = process.env.IMAGE_MODEL || "nano_banana_pro";
const PROMPT_OVERRIDE_PATH = process.env.PROMPT_JSON || path.join(ROOT, "promptimage.json");
const ASPECT_IMG = "IMAGE_ASPECT_RATIO_LANDSCAPE";
const ASPECT_VID = "VIDEO_ASPECT_RATIO_LANDSCAPE";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10", 10);
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || "25", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Concurrency limiter (max N in flight).
function pLimit(concurrency) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= concurrency || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { running--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// Rate limiter (tokens per minute, simple gap-based).
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
function loadSettings() {
  const p = path.join(ROOT, "config/settings.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}
function loadGenaiproKey() {
  const k = process.env.GENAIPRO_API_KEY || loadEnvLocal().GENAIPRO_API_KEY || loadSettings().genaiproKey;
  if (!k) {
    console.error("❌ GENAIPRO_API_KEY manquante. Ajoute-la dans .env.local");
    process.exit(1);
  }
  return k;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function readXlsxRows(xlsxPath) {
  const xml = execFileSync("unzip", ["-p", xlsxPath, "xl/worksheets/sheet1.xml"], {
    encoding: "utf-8", maxBuffer: 50 * 1024 * 1024,
  });
  const rows = [];
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIdx = parseInt(m[1], 10);
    const cells = {};
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const inner = c[3];
      let value = "";
      const inlineStr = inner.match(/<is>(?:<r>(?:<rPr>[\s\S]*?<\/rPr>)?<t[^>]*>([\s\S]*?)<\/t><\/r>|<t[^>]*>([\s\S]*?)<\/t>)<\/is>/);
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (inlineStr) value = decodeXmlEntities(inlineStr[1] ?? inlineStr[2] ?? "");
      else if (v) value = v[1];
      cells[c[1]] = value;
    }
    rows.push({ rowIdx, cells });
  }
  return rows;
}
function rowToPrompt(r) {
  return {
    n: parseInt(r.cells.A, 10),
    epoch: r.cells.B || "",
    imagePrompt: r.cells.C || "",
    videoPrompt: r.cells.D || "",
  };
}

// promptimage.json overrides image_prompt per row. Shapes: string | {prompt} | {[n]: prompt} | array.
function loadPromptOverride(selectedRows) {
  if (!existsSync(PROMPT_OVERRIDE_PATH)) return null;
  const raw = readFileSync(PROMPT_OVERRIDE_PATH, "utf-8").trim();
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`promptimage.json invalide: ${e.message}`); }
  const map = new Map();
  if (typeof data === "string") {
    for (const r of selectedRows) map.set(r.n, data);
  } else if (Array.isArray(data)) {
    if (data.every(x => typeof x === "string")) {
      selectedRows.forEach((r, i) => { if (data[i]) map.set(r.n, data[i]); });
    } else {
      for (const item of data) {
        const n = parseInt(item.n ?? item.N ?? item.row, 10);
        const p = item.prompt || item.image_prompt || item.imagePrompt;
        if (n && p) map.set(n, p);
      }
    }
  } else if (data && typeof data === "object") {
    if (typeof data.prompt === "string" && Object.keys(data).length <= 3) {
      for (const r of selectedRows) map.set(r.n, data.prompt);
    } else {
      for (const [k, v] of Object.entries(data)) {
        const n = parseInt(k, 10);
        const p = typeof v === "string" ? v : (v?.prompt || v?.image_prompt);
        if (n && p) map.set(n, p);
      }
    }
  }
  return map.size ? map : null;
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
    const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(180_000, () => { req.destroy(); reject(new Error(`HTTP ${method} timeout`)); });
    if (body) req.write(body);
    req.end();
  });
}
// CDN migré : files.genaipro.vn → genaipro.io/files/
function rewriteCdnUrl(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}
function httpsDownload(url) {
  const target = rewriteCdnUrl(url);
  return new Promise((resolve, reject) => {
    https.get(target, { headers: { "User-Agent": "FreedomFactory/1.0" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${target}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function createImage(token, prompt) {
  const { body, contentType } = buildMultipart([
    ["prompt", prompt],
    ["aspect_ratio", ASPECT_IMG],
    ["number_of_images", "1"],
    ["model", IMAGE_MODEL],
  ]);
  const res = await httpsRequest("POST", `${API_BASE}/v2/veo/create-image`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "Content-Length": body.length,
  }, body);
  if (res.status !== 202) {
    throw new Error(`create-image ${res.status}: ${res.body.toString("utf-8").slice(0, 500)}`);
  }
  return JSON.parse(res.body.toString("utf-8"));
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
  if (!history) throw new Error(`frames-to-video: no history in response`);
  return history;
}

// Collective polling via /v2/veo/histories — 1 GET per cycle for ALL pending tasks.
// Returns Map<taskId, historyItem>. Tasks still processing past POLL_TIMEOUT_MS are left out.
async function pollHistoriesUntilDone(token, taskIds, label) {
  const TIMEOUT = parseInt(process.env.POLL_TIMEOUT_MS || "600000", 10);
  const pending = new Set(taskIds);
  const results = new Map();
  const start = Date.now();
  let succeeded = 0, failed = 0;
  let cycle = 0;
  while (pending.size > 0) {
    if (Date.now() - start > TIMEOUT) {
      process.stdout.write(`\n⏰ [${label}] Polling timeout (${TIMEOUT/1000}s). ${pending.size} task(s) toujours processing — abandonnées : ${[...pending].map(id => id.slice(0,8)).join(", ")}\n`);
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
        if (item.status === "completed") {
          results.set(item.id, item);
          pending.delete(item.id);
          succeeded++;
        } else if (item.status === "failed") {
          results.set(item.id, item);
          pending.delete(item.id);
          failed++;
        }
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages) break;
      if (items.length === 0) break;
      page++;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[${label}] ✅${succeeded} ❌${failed} ⏳${pending.size} (${elapsed}s, cycle ${++cycle})        `);
    if (pending.size === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");
  return results;
}

function ensureDirs() {
  for (const d of [OUT_DIR, IMG_DIR, CLIP_DIR]) mkdirSync(d, { recursive: true });
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}
function extFromUrl(u, fallback) {
  const m = u.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : fallback;
}
// Detect actual image format from magic bytes — GenAIPro serves JPEG with .png extension.
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
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { entries: [] };
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}
function saveManifest(m) { writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }

function askYn(q) {
  if (process.env.AUTO_CONFIRM) return Promise.resolve(true);
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("Pas de TTY — lance dans un terminal interactif (ou AUTO_CONFIRM=1)"));
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

async function main() {
  if (!existsSync(XLSX_PATH)) throw new Error(`xlsx introuvable: ${XLSX_PATH}`);
  const token = loadGenaiproKey();
  ensureDirs();

  console.log(`📄 ${XLSX_PATH}`);
  const allRows = readXlsxRows(XLSX_PATH);
  const dataRows = allRows.filter(r => r.rowIdx > 1).map(rowToPrompt);

  let selected;
  if (ROWS_RAW) {
    const wanted = ROWS_RAW.split(",").map(s => parseInt(s.trim(), 10)).filter(Boolean);
    selected = wanted.map(n => dataRows.find(r => r.n === n)).filter(Boolean);
    if (selected.length !== wanted.length) {
      console.warn(`⚠️  ${wanted.length - selected.length} ligne(s) introuvable(s) sur ${wanted.join(",")}`);
    }
  } else {
    selected = dataRows;
  }

  const override = loadPromptOverride(selected);
  if (override) {
    console.log(`🔁 Override depuis ${path.relative(ROOT, PROMPT_OVERRIDE_PATH)} (${override.size} prompt(s))`);
    for (const p of selected) {
      const ovp = override.get(p.n);
      if (ovp) p.imagePrompt = ovp;
    }
  }
  console.log(`🎯 ${selected.length} lignes (modèle image: ${IMAGE_MODEL}, concurrency: ${CONCURRENCY}, rate: ${RATE_PER_MIN}/min, poll: ${POLL_INTERVAL_MS}ms)`);

  const manifest = loadManifest();
  const limit = pLimit(CONCURRENCY);
  const dlLimit = pLimit(5);
  const acquireRate = makeRateLimiter(RATE_PER_MIN);

  // ============ VIDEOS_ONLY — skip Phase 1, load images from disk ============
  if (process.env.VIDEOS_ONLY) {
    const fs = await import("fs");
    const files = fs.readdirSync(IMG_DIR).filter(f => /^\d+_.+\.(png|jpg|jpeg|webp)$/i.test(f));
    const imgResults = [];
    for (const f of files) {
      const m = f.match(/^(\d+)_/);
      const n = parseInt(m[1], 10);
      const row = selected.find(r => r.n === n);
      if (!row) continue;
      const fpath = path.join(IMG_DIR, f);
      imgResults.push({ ...row, imagePath: fpath, imageBuf: fs.readFileSync(fpath) });
    }
    if (!imgResults.length) throw new Error(`Aucune image trouvée dans ${IMG_DIR} pour les rows demandées`);
    console.log(`📦 VIDEOS_ONLY — ${imgResults.length} image(s) chargée(s) depuis disque`);
    await runPhase2(token, imgResults, manifest, limit, dlLimit, acquireRate);
    return;
  }

  // ============ PHASE 1 — IMAGES ============
  console.log(`\n=== PHASE 1 : ${selected.length} images en parallèle ===`);
  const t1 = Date.now();
  const imgTasks = await Promise.all(selected.map(p => limit(async () => {
    await acquireRate();
    try {
      const task = await createImage(token, p.imagePrompt);
      console.log(`[img#${p.n}] task ${task.id}`);
      return { ...p, taskId: task.id };
    } catch (e) {
      console.error(`[img#${p.n}] POST échec: ${e.message}`);
      return { ...p, taskId: null, error: e.message };
    }
  })));
  const validImgTasks = imgTasks.filter(t => t.taskId);
  if (!validImgTasks.length) throw new Error("Aucun POST create-image accepté");
  console.log(`✅ ${validImgTasks.length}/${selected.length} POST create-image acceptés en ${Math.round((Date.now()-t1)/1000)}s`);

  console.log(`⏳ Polling collectif via /histories (${POLL_INTERVAL_MS/1000}s/cycle)...`);
  const taskResults = await pollHistoriesUntilDone(token, validImgTasks.map(t => t.taskId), "img-poll");

  console.log(`⬇️  Download images (parallèle, max 5)...`);
  const imgResults = await Promise.all(validImgTasks.map(t => dlLimit(async () => {
    const r = taskResults.get(t.taskId);
    if (!r || r.status !== "completed") {
      console.error(`[img#${t.n}] ${r?.status || 'missing'}: ${r?.error || ''}`);
      return null;
    }
    const url = r.file_urls?.[0];
    if (!url) { console.error(`[img#${t.n}] no file_url`); return null; }
    const buf = await httpsDownload(url);
    const ext = extFromUrl(url, "png");
    const fname = `${String(t.n).padStart(2, "0")}_${slug(t.epoch)}.${ext}`;
    const fpath = path.join(IMG_DIR, fname);
    await writeFile(fpath, buf);
    console.log(`✅ img#${t.n} → ${path.relative(ROOT, fpath)} (${(buf.length/1024).toFixed(0)} KB)`);
    const existing = manifest.entries.find(e => e.n === t.n);
    const entry = existing || { n: t.n, epoch: t.epoch };
    entry.image = { taskId: t.taskId, url, path: fpath };
    if (!existing) manifest.entries.push(entry);
    saveManifest(manifest);
    return { ...t, imagePath: fpath, imageUrl: url, imageBuf: buf };
  }))).then(arr => arr.filter(Boolean));

  if (!imgResults.length) throw new Error("Aucune image téléchargée");

  // ============ HUMAN GATE ============
  if (process.env.IMAGES_ONLY) {
    console.log(`\n✅ IMAGES_ONLY — ${imgResults.length} image(s) sauvée(s) dans ${path.relative(ROOT, IMG_DIR)}`);
    return;
  }
  console.log(`\n=== 🚦 HUMAN GATE ===`);
  console.log(`Inspecte les ${imgResults.length} images dans : ${path.relative(ROOT, IMG_DIR)}`);
  console.log(`   open "${IMG_DIR}"`);
  const ok = await askYn(`\n✋ Continuer vers I2V pour ${imgResults.length} image(s) ? (y/N) `);
  if (!ok) { console.log("Stoppé. Images sauvées."); return; }

  await runPhase2(token, imgResults, manifest, limit, dlLimit, acquireRate);
}

async function runPhase2(token, imgResults, manifest, limit, dlLimit, acquireRate) {
  console.log(`\n=== PHASE 2 : ${imgResults.length} vidéos en parallèle ===`);
  const t2 = Date.now();
  const vidTasks = await Promise.all(imgResults.map(r => limit(async () => {
    await acquireRate();
    try {
      const history = await framesToVideo(token, r.imageBuf, path.basename(r.imagePath), r.videoPrompt);
      console.log(`[vid#${r.n}] task ${history.id}`);
      return { ...r, vidTaskId: history.id };
    } catch (e) {
      console.error(`[vid#${r.n}] POST échec: ${e.message}`);
      return { ...r, vidTaskId: null, error: e.message };
    }
  })));
  const validVidTasks = vidTasks.filter(t => t.vidTaskId);
  if (!validVidTasks.length) throw new Error("Aucun POST frames-to-video accepté");
  console.log(`✅ ${validVidTasks.length}/${imgResults.length} POST frames-to-video acceptés en ${Math.round((Date.now()-t2)/1000)}s`);

  console.log(`⏳ Polling collectif via /histories...`);
  const vidResults = await pollHistoriesUntilDone(token, validVidTasks.map(t => t.vidTaskId), "vid-poll");

  console.log(`⬇️  Download vidéos...`);
  const downloaded = [], failedN = [], stuckN = [];
  await Promise.all(validVidTasks.map(t => dlLimit(async () => {
    const r = vidResults.get(t.vidTaskId);
    if (!r) { stuckN.push(t.n); return; }
    if (r.status === "failed") { failedN.push(t.n); return; }
    if (r.status !== "completed") { stuckN.push(t.n); return; }
    const url = r.file_urls?.[0];
    if (!url) { failedN.push(t.n); return; }
    const buf = await httpsDownload(url);
    const ext = extFromUrl(url, "mp4");
    const fname = `${String(t.n).padStart(2, "0")}_${slug(t.epoch)}.${ext}`;
    const fpath = path.join(CLIP_DIR, fname);
    await writeFile(fpath, buf);
    console.log(`✅ vid#${t.n} → ${path.relative(ROOT, fpath)} (${(buf.length/1024/1024).toFixed(1)} MB)`);
    const entry = manifest.entries.find(e => e.n === t.n);
    if (entry) {
      entry.video = { taskId: t.vidTaskId, url, path: fpath };
      saveManifest(manifest);
    }
    downloaded.push(t.n);
  })));

  console.log(`\n=== RÉCAP ===`);
  console.log(`✅ Téléchargées (${downloaded.length}): ${downloaded.sort((a,b)=>a-b).join(", ") || "—"}`);
  if (failedN.length) console.log(`❌ Failed côté Veo (${failedN.length}, crédits remboursés): ${failedN.sort((a,b)=>a-b).join(", ")}`);
  if (stuckN.length) console.log(`⏰ Toujours processing au timeout (${stuckN.length}): ${stuckN.sort((a,b)=>a-b).join(", ")}`);
  console.log(`Manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
}

main().catch(err => { console.error("\n💥", err.message); process.exit(1); });
