#!/usr/bin/env node
// gen-galveston.mjs — pipeline GenAIPro Veo V2 — V1.5 rolling pipeline
//
// Mode par défaut (rolling) : POST images en parallèle ; dès qu'une image est
// téléchargée et passe la QA basique → POST de la vidéo immédiatement.
// Plus aucun temps mort entre phase image et phase vidéo.
//
//   node scripts/gen-galveston.mjs                         # rolling pipeline (image→vidéo auto)
//   IMAGES_ONLY=1 node scripts/gen-galveston.mjs           # juste images, pas d'auto-trigger vidéo
//   VIDEOS_ONLY=1 node scripts/gen-galveston.mjs           # juste anime images existantes
//   RESUME=1 node scripts/gen-galveston.mjs                # reprend tasks en cours via state.json
//   IDS=1,8,22 node scripts/gen-galveston.mjs              # filtre sur scènes
//   FAILED_ONLY=1 node scripts/gen-galveston.mjs           # re-POST scènes failed
//   STUCK_ONLY=1 node scripts/gen-galveston.mjs            # re-POST scènes stuck
//   REGEN_IMAGES=1 IDS=3,7 ...                             # force regen images
//   REGEN_VIDEOS=1 IDS=3,7 ...                             # force regen videos
//   AUTO_VIDEO_AFTER_IMAGE=0 ...                           # désactive le rolling
//
// Robustesse :
//   - Stream download disque (vidéos) via stream/pipeline — pas en RAM.
//   - State persistant OUT_DIR/state.json : résiste aux crashes (DNS, etc.).
//   - Skip auto si fichier déjà sur disque.
//   - Retry réseau (DNS/timeout/EAI_AGAIN/429 avec Retry-After) en backoff.
//   - Per-task stuck watchdog : 1 task bloquée n'empêche pas les autres.
//   - Basic QA image (taille>50KB + magic number) → regen auto si attempt < MAX.
//   - Rate limits séparés image / video / history (30/min cap par endpoint).

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream } from "fs";
import { writeFile, readFile, stat, unlink } from "fs/promises";
import { pipeline } from "stream/promises";
import https from "https";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROJECT_NAME = process.env.PROJECT_NAME || "galveston_1900";
const PROMPTS_PATH = process.env.PROMPTS_PATH || path.join(ROOT, `${PROJECT_NAME}_prompts.json`);
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_NAME);
const IMG_DIR = path.join(OUT_DIR, "images");
const CLIP_DIR = path.join(OUT_DIR, "clips");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const STATE_PATH = path.join(OUT_DIR, "state.json");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ASPECT_IMG = process.env.IMAGE_ASPECT_RATIO || "IMAGE_ASPECT_RATIO_LANDSCAPE";
const ASPECT_VID = process.env.VIDEO_ASPECT_RATIO || "VIDEO_ASPECT_RATIO_LANDSCAPE";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "nano_banana_pro";

// Concurrency & rate
const IMAGE_CONCURRENCY = parseInt(process.env.IMAGE_CONCURRENCY || process.env.CONCURRENCY || "10", 10);
const VIDEO_CONCURRENCY = parseInt(process.env.VIDEO_CONCURRENCY || process.env.CONCURRENCY || "6", 10);
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY || "5", 10);
const IMAGE_RATE_PER_MIN = parseInt(process.env.IMAGE_RATE_PER_MIN || "29", 10);
const VIDEO_RATE_PER_MIN = parseInt(process.env.VIDEO_RATE_PER_MIN || "29", 10);
const HISTORY_RATE_PER_MIN = parseInt(process.env.HISTORY_RATE_PER_MIN || "29", 10);

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "12000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || "1800000", 10);
const STUCK_AFTER_MS = parseInt(process.env.STUCK_AFTER_MS || "720000", 10); // 12 min
const MAX_IMAGE_ATTEMPTS = parseInt(process.env.MAX_IMAGE_ATTEMPTS || "3", 10);
const MAX_VIDEO_ATTEMPTS = parseInt(process.env.MAX_VIDEO_ATTEMPTS || "2", 10);
const QA_MIN_SIZE = parseInt(process.env.QA_MIN_SIZE || "50000", 10); // 50 KB
const AUTO_VIDEO_AFTER_IMAGE = process.env.AUTO_VIDEO_AFTER_IMAGE !== "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
// Utilities
// =============================================================================
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
  if (!k) { console.error("GENAIPRO_API_KEY manquante"); process.exit(1); }
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

const RETRYABLE_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function httpsRequest(method, urlPath, headers, body, retries = 4) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (RETRYABLE_STATUSES.has(res.statusCode) && n > 0) {
            const retryAfter = parseInt(res.headers["retry-after"] || "0", 10) * 1000;
            const wait = res.statusCode === 429 ? Math.max(retryAfter, 30_000) : delay;
            console.warn(`[${res.statusCode} ${method} ${urlPath.slice(0, 60)}] retry in ${wait}ms (${n} left)`);
            setTimeout(() => attempt(n - 1, Math.min(delay * 2, 60_000)), wait);
            return;
          }
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        });
      });
      req.on("error", (err) => {
        if (n > 0 && (RETRYABLE_ERRORS.has(err.code) || /timeout/i.test(err.message))) {
          console.warn(`[retry ${method} ${urlPath.slice(0, 60)}] ${err.code || err.message} (${n} left, wait ${delay}ms)`);
          setTimeout(() => attempt(n - 1, Math.min(delay * 2, 60_000)), delay);
        } else reject(err);
      });
      req.setTimeout(180_000, () => {
        req.destroy();
        if (n > 0) { console.warn(`[retry timeout ${method}] (${n} left)`); setTimeout(() => attempt(n - 1, Math.min(delay * 2, 60_000)), delay); }
        else reject(new Error(`HTTP ${method} timeout`));
      });
      if (body) req.write(body);
      req.end();
    };
    attempt(retries, 3000);
  });
}

function rewriteCdnUrl(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}

// Streaming download : pipe directement vers le disque (pas en RAM).
async function streamDownload(url, outputPath, retries = 4) {
  const target = rewriteCdnUrl(url);
  const attempt = async (n, delay) => {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = https.get(target, { headers: { "User-Agent": "FreedomFactory/1.0" } }, resolve);
        req.on("error", reject);
        req.setTimeout(180_000, () => { req.destroy(new Error("download timeout")); });
      });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return streamDownload(res.headers.location, outputPath, n);
      }
      if (res.statusCode !== 200) {
        res.resume();
        if (n > 0 && RETRYABLE_STATUSES.has(res.statusCode)) {
          console.warn(`[retry-stream-dl] HTTP ${res.statusCode} (${n} left)`);
          await sleep(delay);
          return attempt(n - 1, Math.min(delay * 2, 60_000));
        }
        throw new Error(`HTTP ${res.statusCode} downloading ${target}`);
      }
      const tmpPath = `${outputPath}.tmp`;
      await pipeline(res, createWriteStream(tmpPath));
      // atomic rename
      const { rename } = await import("fs/promises");
      await rename(tmpPath, outputPath);
      const st = await stat(outputPath);
      return st.size;
    } catch (err) {
      if (n > 0 && (RETRYABLE_ERRORS.has(err.code) || /timeout|abort/i.test(err.message))) {
        console.warn(`[retry-stream-dl] ${err.code || err.message} (${n} left)`);
        await sleep(delay);
        return attempt(n - 1, Math.min(delay * 2, 60_000));
      }
      throw err;
    }
  };
  return attempt(retries, 3000);
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

// =============================================================================
// QA
// =============================================================================
async function basicImageQA(filePath) {
  try {
    const st = await stat(filePath);
    if (st.size < QA_MIN_SIZE) {
      return { ok: false, reason: `file too small: ${st.size} < ${QA_MIN_SIZE}`, canRegenerate: true };
    }
    const fh = await import("fs/promises").then((m) => m.open(filePath, "r"));
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    await fh.close();
    const detected = detectImageType(head);
    if (detected.ext === "bin") {
      return { ok: false, reason: "invalid magic number (no png/jpg/webp signature)", canRegenerate: true };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `QA error: ${e.message}`, canRegenerate: true };
  }
}

// =============================================================================
// API calls
// =============================================================================
async function postCreateImage(token, prompt) {
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
  if (res.status !== 202)
    throw new Error(`create-image ${res.status}: ${res.body.toString("utf-8").slice(0, 400)}`);
  return JSON.parse(res.body.toString("utf-8"));
}

async function postFramesToVideo(token, imageBuffer, imageName, prompt) {
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
  if (res.status !== 202)
    throw new Error(`frames-to-video ${res.status}: ${res.body.toString("utf-8").slice(0, 400)}`);
  const data = JSON.parse(res.body.toString("utf-8"));
  const history = data.histories?.[0];
  if (!history) throw new Error("frames-to-video: no history");
  return history;
}

// =============================================================================
// Persistence
// =============================================================================
function ensureDirs() { for (const d of [OUT_DIR, IMG_DIR, CLIP_DIR]) mkdirSync(d, { recursive: true }); }
function loadJSON(p, fallback) { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : fallback; }
function saveJSON(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2)); }
function loadManifest() { return loadJSON(MANIFEST_PATH, { project: PROJECT_NAME, created_at: Date.now(), updated_at: Date.now(), entries: [] }); }
function saveManifest(m) { m.updated_at = Date.now(); saveJSON(MANIFEST_PATH, m); }
function loadState() { return loadJSON(STATE_PATH, { images: {}, videos: {} }); }
function saveState(s) { saveJSON(STATE_PATH, s); }

function findExisting(dir, id, section) {
  if (!existsSync(dir)) return null;
  const prefix = `${String(id).padStart(2, "0")}_${slug(section)}.`;
  return readdirSync(dir).find((f) => f.startsWith(prefix));
}

function askYn(q) {
  if (process.env.AUTO_CONFIRM) return Promise.resolve(true);
  if (!process.stdin.isTTY) return Promise.reject(new Error("Pas de TTY — utilise IMAGES_ONLY=1 / VIDEOS_ONLY=1 / AUTO_CONFIRM=1"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

// =============================================================================
// Scene selection (IDS / FAILED_ONLY / STUCK_ONLY)
// =============================================================================
function selectScenes(spec, state) {
  let scenes = spec.scenes;
  if (process.env.IDS) {
    const wanted = process.env.IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    scenes = scenes.filter((s) => wanted.includes(s.id));
  }
  if (process.env.FAILED_ONLY) {
    const failedIds = new Set();
    for (const kind of ["images", "videos"]) {
      for (const st of Object.values(state[kind])) {
        if (st.failed) failedIds.add(st.id);
      }
    }
    scenes = scenes.filter((s) => failedIds.has(s.id));
  }
  if (process.env.STUCK_ONLY) {
    const stuckIds = new Set();
    for (const kind of ["images", "videos"]) {
      for (const st of Object.values(state[kind])) {
        if (st.stuck) stuckIds.add(st.id);
      }
    }
    scenes = scenes.filter((s) => stuckIds.has(s.id));
  }
  return scenes;
}

// =============================================================================
// Rolling pipeline — V1.5 core. POST images en parallèle ; dès qu'une image
// est DL+QA-pass, POST sa vidéo immédiatement. Single poll loop pour les deux.
// =============================================================================
async function rollingPipeline(token, scenes, state, manifest) {
  const imageRate = makeRateLimiter(IMAGE_RATE_PER_MIN);
  const videoRate = makeRateLimiter(VIDEO_RATE_PER_MIN);
  const historyRate = makeRateLimiter(HISTORY_RATE_PER_MIN);
  const imagePostLimit = pLimit(IMAGE_CONCURRENCY);
  const videoPostLimit = pLimit(VIDEO_CONCURRENCY);
  const dlLimit = pLimit(DOWNLOAD_CONCURRENCY);

  // pending: taskId -> { kind: 'image'|'video', scene, postedAt, attempt }
  const pending = new Map();
  // tracking in-flight async work (POSTs + downloads + chained operations)
  let inFlight = 0;
  const tracked = (p) => { inFlight++; p.finally(() => inFlight--); return p; };

  let imagesDone = 0, imagesQAFailed = 0, imagesFailed = 0;
  let videosDone = 0, videosFailed = 0;
  const stuckScenes = new Set();

  const onCriticalError = (e) => console.warn(`[err] ${e.message}`);

  // Schedule an image POST. If attempt > MAX, mark scene as image-failed.
  const scheduleImagePost = (scene, attempt = 1) => {
    if (attempt > MAX_IMAGE_ATTEMPTS) {
      console.log(`[img#${scene.id}] MAX_IMAGE_ATTEMPTS atteint — abandon`);
      imagesFailed++;
      return;
    }
    return tracked(imagePostLimit(async () => {
      try {
        await imageRate();
        const task = await postCreateImage(token, scene.image_prompt);
        console.log(`[img#${scene.id}] task ${task.id} (attempt ${attempt})`);
        state.images[task.id] = { id: scene.id, section: scene.section, postedAt: Date.now(), downloaded: false, attempt };
        saveState(state);
        pending.set(task.id, { kind: "image", scene, postedAt: Date.now(), attempt });
      } catch (e) {
        console.error(`[img#${scene.id}] POST échec: ${e.message}`);
        imagesFailed++;
      }
    }));
  };

  // Schedule a video POST. If attempt > MAX, mark scene as video-failed.
  const scheduleVideoPost = (scene, imagePath, attempt = 1) => {
    if (attempt > MAX_VIDEO_ATTEMPTS) {
      console.log(`[vid#${scene.id}] MAX_VIDEO_ATTEMPTS atteint — abandon`);
      videosFailed++;
      return;
    }
    return tracked(videoPostLimit(async () => {
      try {
        await videoRate();
        const buf = await readFile(imagePath);
        const history = await postFramesToVideo(token, buf, path.basename(imagePath), scene.animation_prompt);
        console.log(`[vid#${scene.id}] task ${history.id} (attempt ${attempt})`);
        state.videos[history.id] = { id: scene.id, section: scene.section, postedAt: Date.now(), downloaded: false, attempt };
        saveState(state);
        pending.set(history.id, { kind: "video", scene, postedAt: Date.now(), attempt });
      } catch (e) {
        console.error(`[vid#${scene.id}] POST échec: ${e.message}`);
        videosFailed++;
      }
    }));
  };

  // Initial scheduling: for each scene, decide what to do.
  for (const scene of scenes) {
    // already have a clip? skip entirely
    if (findExisting(CLIP_DIR, scene.id, scene.section) && !process.env.REGEN_VIDEOS) continue;

    if (process.env.REGEN_VIDEOS && findExisting(CLIP_DIR, scene.id, scene.section)) {
      // remove existing clip + state entries, re-trigger from existing image
      await unlink(path.join(CLIP_DIR, findExisting(CLIP_DIR, scene.id, scene.section))).catch(() => {});
      for (const tid of Object.keys(state.videos)) {
        if (state.videos[tid].id === scene.id) delete state.videos[tid];
      }
      saveState(state);
    }
    if (process.env.REGEN_IMAGES && findExisting(IMG_DIR, scene.id, scene.section)) {
      await unlink(path.join(IMG_DIR, findExisting(IMG_DIR, scene.id, scene.section))).catch(() => {});
      for (const tid of Object.keys(state.images)) {
        if (state.images[tid].id === scene.id) delete state.images[tid];
      }
      saveState(state);
    }

    const imgFile = findExisting(IMG_DIR, scene.id, scene.section);
    if (imgFile) {
      // image OK — go straight to video (if rolling enabled)
      if (AUTO_VIDEO_AFTER_IMAGE) {
        scheduleVideoPost(scene, path.join(IMG_DIR, imgFile));
      }
      continue;
    }

    // resume case: image already POSTed, no file yet, not failed
    const existingImg = Object.entries(state.images).find(([, st]) => st.id === scene.id && !st.downloaded && !st.failed);
    if (existingImg) {
      const [tid, st] = existingImg;
      pending.set(tid, { kind: "image", scene, postedAt: st.postedAt || Date.now(), attempt: st.attempt || 1 });
      console.log(`[resume img#${scene.id}] task ${tid}`);
      continue;
    }

    scheduleImagePost(scene, 1);
  }

  // Also resume any video tasks already in state
  for (const [tid, st] of Object.entries(state.videos)) {
    if (st.downloaded || st.failed) continue;
    if (pending.has(tid)) continue;
    const scene = scenes.find((s) => s.id === st.id);
    if (!scene) continue;
    pending.set(tid, { kind: "video", scene, postedAt: st.postedAt || Date.now(), attempt: st.attempt || 1 });
    console.log(`[resume vid#${scene.id}] task ${tid}`);
  }

  // Download + post-DL handler
  const downloadAndProcess = async (taskId, kind, scene, url) => {
    const stateBucket = kind === "image" ? state.images : state.videos;
    const targetDir = kind === "image" ? IMG_DIR : CLIP_DIR;
    const fallbackExt = kind === "image" ? "png" : "mp4";
    const ext = extFromUrl(url, fallbackExt);
    const fname = `${String(scene.id).padStart(2, "0")}_${slug(scene.section)}.${ext}`;
    const fpath = path.join(targetDir, fname);
    try {
      const size = await streamDownload(url, fpath);
      const sizeStr = kind === "image" ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
      console.log(`OK ${kind === "image" ? "img" : "vid"}#${scene.id} -> ${path.relative(ROOT, fpath)} (${sizeStr})`);
      stateBucket[taskId].downloaded = true;
      stateBucket[taskId].path = fpath;
      saveState(state);
      const entry = manifest.entries.find((e) => e.id === scene.id) || (() => { const e = { id: scene.id, section: scene.section }; manifest.entries.push(e); return e; })();
      entry[kind] = { taskId, url, path: fpath, attempt: stateBucket[taskId].attempt || 1 };
      saveManifest(manifest);

      if (kind === "image") {
        const qa = await basicImageQA(fpath);
        if (!qa.ok) {
          console.log(`[QA-FAIL img#${scene.id}] ${qa.reason}`);
          stateBucket[taskId].qa_failed = true; stateBucket[taskId].qa_reason = qa.reason;
          saveState(state);
          imagesQAFailed++;
          // delete bad file so it's not picked up next time
          await unlink(fpath).catch(() => {});
          delete entry.image;
          saveManifest(manifest);
          if (qa.canRegenerate) {
            const nextAttempt = (stateBucket[taskId].attempt || 1) + 1;
            console.log(`[regen img#${scene.id}] attempt ${nextAttempt}`);
            scheduleImagePost(scene, nextAttempt);
          }
          return;
        }
        imagesDone++;
        if (AUTO_VIDEO_AFTER_IMAGE) {
          if (!findExisting(CLIP_DIR, scene.id, scene.section)) {
            scheduleVideoPost(scene, fpath, 1);
          }
        }
      } else {
        videosDone++;
      }
    } catch (e) {
      console.error(`[${kind}#${scene.id}] DL échec: ${e.message}`);
      // attempt cleanup
      await unlink(`${fpath}.tmp`).catch(() => {});
      if (kind === "image") imagesFailed++; else videosFailed++;
    }
  };

  // Main polling loop
  const start = Date.now();
  let cycle = 0;
  while (true) {
    // Termination: nothing pending, no in-flight POSTs, no in-flight downloads (inFlight === 0).
    if (pending.size === 0 && inFlight === 0) {
      // small grace to allow last spawn
      await sleep(300);
      if (pending.size === 0 && inFlight === 0) break;
    }

    if (Date.now() - start > POLL_TIMEOUT_MS) {
      console.log(`\n[poll] timeout global (${POLL_TIMEOUT_MS / 1000}s) — abandon ${pending.size} task(s)`);
      break;
    }

    // Poll histories (single endpoint covers both kinds)
    if (pending.size > 0) {
      try {
        await historyRate();
        let page = 1;
        while (true) {
          const res = await httpsRequest("GET",
            `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`,
            { Authorization: `Bearer ${token}` });
          if (res.status !== 200) throw new Error(`histories ${res.status}`);
          const body = JSON.parse(res.body.toString("utf-8"));
          const items = body.data || [];
          for (const item of items) {
            if (!pending.has(item.id)) continue;
            const { kind, scene } = pending.get(item.id);
            const stateBucket = kind === "image" ? state.images : state.videos;
            if (item.status === "completed") {
              const url = item.file_urls?.[0];
              if (!url) {
                console.log(`[${kind}#${scene.id}] completed sans url — fail`);
                stateBucket[item.id].failed = true; saveState(state);
                pending.delete(item.id);
                if (kind === "image") imagesFailed++; else videosFailed++;
                continue;
              }
              stateBucket[item.id].url = url;
              stateBucket[item.id].completedAt = Date.now();
              saveState(state);
              pending.delete(item.id);
              tracked(dlLimit(() => downloadAndProcess(item.id, kind, scene, url)));
            } else if (item.status === "failed") {
              const errMsg = item.error || "(no msg)";
              console.log(`FAIL ${kind}#${scene.id}: ${errMsg}`);
              stateBucket[item.id].failed = true; stateBucket[item.id].error = errMsg;
              saveState(state);
              pending.delete(item.id);
              // retry policy : if attempt < MAX, schedule another POST
              const attempt = pending.get(item.id)?.attempt || stateBucket[item.id].attempt || 1;
              if (kind === "image" && attempt < MAX_IMAGE_ATTEMPTS) {
                scheduleImagePost(scene, attempt + 1);
              } else if (kind === "video" && attempt < MAX_VIDEO_ATTEMPTS) {
                const imgFile = findExisting(IMG_DIR, scene.id, scene.section);
                if (imgFile) scheduleVideoPost(scene, path.join(IMG_DIR, imgFile), attempt + 1);
                else videosFailed++;
              } else {
                if (kind === "image") imagesFailed++; else videosFailed++;
              }
            }
          }
          const totalPages = body.total_pages ?? 1;
          if (page >= totalPages || items.length === 0) break;
          page++;
        }
      } catch (e) { onCriticalError(e); }
    }

    // Stuck watchdog
    const now = Date.now();
    for (const [tid, info] of [...pending.entries()]) {
      if (now - info.postedAt > STUCK_AFTER_MS) {
        const stateBucket = info.kind === "image" ? state.images : state.videos;
        stateBucket[tid].stuck = true; saveState(state);
        console.log(`STUCK ${info.kind}#${info.scene.id} (>${Math.round(STUCK_AFTER_MS / 60000)}min)`);
        pending.delete(tid);
        stuckScenes.add(`${info.kind}#${info.scene.id}`);
      }
    }

    process.stdout.write(`\r[stats] img=${imagesDone}/${imagesQAFailed}qa/${imagesFailed}f vid=${videosDone}/${videosFailed}f pending=${pending.size} flight=${inFlight} stuck=${stuckScenes.size} (c${++cycle})        `);
    if (pending.size === 0 && inFlight === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");

  console.log(`\n=== RECAP ===`);
  console.log(`Images : ${imagesDone} OK, ${imagesQAFailed} QA-fail, ${imagesFailed} échec`);
  console.log(`Videos : ${videosDone} OK, ${videosFailed} échec`);
  if (stuckScenes.size) console.log(`Stuck  : ${[...stuckScenes].join(", ")}  (relance avec STUCK_ONLY=1)`);
  console.log(`State  : ${path.relative(ROOT, STATE_PATH)}`);
  console.log(`Manifest : ${path.relative(ROOT, MANIFEST_PATH)}`);
}

// =============================================================================
// Mode IMAGES_ONLY (pas d'auto-trigger vidéo)
// =============================================================================
async function imagesOnly(token, scenes, state, manifest) {
  process.env.AUTO_VIDEO_AFTER_IMAGE = "0";
  // Use rollingPipeline but trick it: filter scenes out of video scheduling by
  // overriding via env var (already read at top). Simpler : duplicate small loop.
  // To stay simple, run rolling but with AUTO_VIDEO_AFTER_IMAGE forced 0.
  // The flag is read at top into a const; we need to bypass. Just call image-specific path.
  // Implement: a stripped version focusing only on images.
  const imageRate = makeRateLimiter(IMAGE_RATE_PER_MIN);
  const historyRate = makeRateLimiter(HISTORY_RATE_PER_MIN);
  const imagePostLimit = pLimit(IMAGE_CONCURRENCY);
  const dlLimit = pLimit(DOWNLOAD_CONCURRENCY);
  const pending = new Map();
  let inFlight = 0;
  const tracked = (p) => { inFlight++; p.finally(() => inFlight--); return p; };
  let done = 0, qaFailed = 0, failed = 0;

  const scheduleImage = (scene, attempt = 1) => {
    if (attempt > MAX_IMAGE_ATTEMPTS) { failed++; return; }
    return tracked(imagePostLimit(async () => {
      try {
        await imageRate();
        const task = await postCreateImage(token, scene.image_prompt);
        console.log(`[img#${scene.id}] task ${task.id} (attempt ${attempt})`);
        state.images[task.id] = { id: scene.id, section: scene.section, postedAt: Date.now(), downloaded: false, attempt };
        saveState(state);
        pending.set(task.id, { scene, postedAt: Date.now(), attempt });
      } catch (e) { console.error(`[img#${scene.id}] POST échec: ${e.message}`); failed++; }
    }));
  };

  for (const scene of scenes) {
    if (findExisting(IMG_DIR, scene.id, scene.section) && !process.env.REGEN_IMAGES) continue;
    if (process.env.REGEN_IMAGES) {
      const ex = findExisting(IMG_DIR, scene.id, scene.section);
      if (ex) await unlink(path.join(IMG_DIR, ex)).catch(() => {});
      for (const tid of Object.keys(state.images)) if (state.images[tid].id === scene.id) delete state.images[tid];
      saveState(state);
    }
    const existing = Object.entries(state.images).find(([, st]) => st.id === scene.id && !st.downloaded && !st.failed);
    if (existing) { const [tid, st] = existing; pending.set(tid, { scene, postedAt: st.postedAt || Date.now(), attempt: st.attempt || 1 }); continue; }
    scheduleImage(scene, 1);
  }

  const start = Date.now();
  while (true) {
    if (pending.size === 0 && inFlight === 0) { await sleep(300); if (pending.size === 0 && inFlight === 0) break; }
    if (Date.now() - start > POLL_TIMEOUT_MS) break;
    if (pending.size > 0) {
      try {
        await historyRate();
        let page = 1;
        while (true) {
          const res = await httpsRequest("GET", `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`, { Authorization: `Bearer ${token}` });
          if (res.status !== 200) throw new Error(`histories ${res.status}`);
          const body = JSON.parse(res.body.toString("utf-8"));
          const items = body.data || [];
          for (const item of items) {
            if (!pending.has(item.id)) continue;
            const { scene, attempt } = pending.get(item.id);
            if (item.status === "completed") {
              const url = item.file_urls?.[0];
              if (!url) { state.images[item.id].failed = true; saveState(state); pending.delete(item.id); failed++; continue; }
              state.images[item.id].url = url; state.images[item.id].completedAt = Date.now(); saveState(state);
              pending.delete(item.id);
              tracked(dlLimit(async () => {
                const ext = extFromUrl(url, "png");
                const fname = `${String(scene.id).padStart(2, "0")}_${slug(scene.section)}.${ext}`;
                const fpath = path.join(IMG_DIR, fname);
                try {
                  const size = await streamDownload(url, fpath);
                  console.log(`OK img#${scene.id} -> ${path.relative(ROOT, fpath)} (${(size / 1024).toFixed(0)} KB)`);
                  state.images[item.id].downloaded = true; state.images[item.id].path = fpath; saveState(state);
                  const entry = manifest.entries.find((e) => e.id === scene.id) || (() => { const e = { id: scene.id, section: scene.section }; manifest.entries.push(e); return e; })();
                  entry.image = { taskId: item.id, url, path: fpath, attempt };
                  saveManifest(manifest);
                  const qa = await basicImageQA(fpath);
                  if (!qa.ok) {
                    console.log(`[QA-FAIL img#${scene.id}] ${qa.reason}`);
                    state.images[item.id].qa_failed = true; saveState(state);
                    qaFailed++;
                    await unlink(fpath).catch(() => {});
                    delete entry.image; saveManifest(manifest);
                    if (qa.canRegenerate) scheduleImage(scene, attempt + 1);
                  } else { done++; }
                } catch (e) { console.error(`[img#${scene.id}] DL échec: ${e.message}`); failed++; }
              }));
            } else if (item.status === "failed") {
              console.log(`FAIL img#${scene.id}: ${item.error || ""}`);
              state.images[item.id].failed = true; saveState(state); pending.delete(item.id);
              if (attempt < MAX_IMAGE_ATTEMPTS) scheduleImage(scene, attempt + 1); else failed++;
            }
          }
          const totalPages = body.total_pages ?? 1;
          if (page >= totalPages || items.length === 0) break;
          page++;
        }
      } catch (e) { console.warn(`[poll] ${e.message}`); }
    }
    const now = Date.now();
    for (const [tid, info] of [...pending.entries()]) {
      if (now - info.postedAt > STUCK_AFTER_MS) {
        state.images[tid].stuck = true; saveState(state);
        console.log(`STUCK img#${info.scene.id}`); pending.delete(tid);
      }
    }
    process.stdout.write(`\r[img] done=${done} qa=${qaFailed} fail=${failed} pending=${pending.size} flight=${inFlight}        `);
    if (pending.size === 0 && inFlight === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");
  console.log(`\nIMAGES_ONLY fini : ${done} OK, ${qaFailed} QA-fail, ${failed} fail.`);
}

// =============================================================================
// Mode VIDEOS_ONLY — anime images existantes
// =============================================================================
async function videosOnly(token, scenes, state, manifest) {
  // Build virtual rolling with AUTO_VIDEO=0 logic isn't right here. Let's do it custom :
  // For each scene with image but no clip → scheduleVideoPost.
  const videoRate = makeRateLimiter(VIDEO_RATE_PER_MIN);
  const historyRate = makeRateLimiter(HISTORY_RATE_PER_MIN);
  const videoPostLimit = pLimit(VIDEO_CONCURRENCY);
  const dlLimit = pLimit(DOWNLOAD_CONCURRENCY);
  const pending = new Map();
  let inFlight = 0;
  const tracked = (p) => { inFlight++; p.finally(() => inFlight--); return p; };
  let done = 0, failed = 0;

  const scheduleVideo = (scene, imagePath, attempt = 1) => {
    if (attempt > MAX_VIDEO_ATTEMPTS) { failed++; return; }
    return tracked(videoPostLimit(async () => {
      try {
        await videoRate();
        const buf = await readFile(imagePath);
        const history = await postFramesToVideo(token, buf, path.basename(imagePath), scene.animation_prompt);
        console.log(`[vid#${scene.id}] task ${history.id} (attempt ${attempt})`);
        state.videos[history.id] = { id: scene.id, section: scene.section, postedAt: Date.now(), downloaded: false, attempt };
        saveState(state);
        pending.set(history.id, { scene, postedAt: Date.now(), attempt });
      } catch (e) { console.error(`[vid#${scene.id}] POST échec: ${e.message}`); failed++; }
    }));
  };

  for (const scene of scenes) {
    if (findExisting(CLIP_DIR, scene.id, scene.section) && !process.env.REGEN_VIDEOS) continue;
    if (process.env.REGEN_VIDEOS) {
      const ex = findExisting(CLIP_DIR, scene.id, scene.section);
      if (ex) await unlink(path.join(CLIP_DIR, ex)).catch(() => {});
      for (const tid of Object.keys(state.videos)) if (state.videos[tid].id === scene.id) delete state.videos[tid];
      saveState(state);
    }
    const imgFile = findExisting(IMG_DIR, scene.id, scene.section);
    if (!imgFile) { console.warn(`[skip vid#${scene.id}] pas d'image`); continue; }
    const imagePath = path.join(IMG_DIR, imgFile);
    const existing = Object.entries(state.videos).find(([, st]) => st.id === scene.id && !st.downloaded && !st.failed);
    if (existing) { const [tid, st] = existing; pending.set(tid, { scene, postedAt: st.postedAt || Date.now(), attempt: st.attempt || 1 }); continue; }
    scheduleVideo(scene, imagePath, 1);
  }

  const start = Date.now();
  while (true) {
    if (pending.size === 0 && inFlight === 0) { await sleep(300); if (pending.size === 0 && inFlight === 0) break; }
    if (Date.now() - start > POLL_TIMEOUT_MS) break;
    if (pending.size > 0) {
      try {
        await historyRate();
        let page = 1;
        while (true) {
          const res = await httpsRequest("GET", `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`, { Authorization: `Bearer ${token}` });
          if (res.status !== 200) throw new Error(`histories ${res.status}`);
          const body = JSON.parse(res.body.toString("utf-8"));
          const items = body.data || [];
          for (const item of items) {
            if (!pending.has(item.id)) continue;
            const { scene, attempt } = pending.get(item.id);
            if (item.status === "completed") {
              const url = item.file_urls?.[0];
              if (!url) { state.videos[item.id].failed = true; saveState(state); pending.delete(item.id); failed++; continue; }
              state.videos[item.id].url = url; state.videos[item.id].completedAt = Date.now(); saveState(state);
              pending.delete(item.id);
              tracked(dlLimit(async () => {
                const ext = extFromUrl(url, "mp4");
                const fname = `${String(scene.id).padStart(2, "0")}_${slug(scene.section)}.${ext}`;
                const fpath = path.join(CLIP_DIR, fname);
                try {
                  const size = await streamDownload(url, fpath);
                  console.log(`OK vid#${scene.id} -> ${path.relative(ROOT, fpath)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
                  state.videos[item.id].downloaded = true; state.videos[item.id].path = fpath; saveState(state);
                  const entry = manifest.entries.find((e) => e.id === scene.id) || (() => { const e = { id: scene.id, section: scene.section }; manifest.entries.push(e); return e; })();
                  entry.video = { taskId: item.id, url, path: fpath, attempt };
                  saveManifest(manifest);
                  done++;
                } catch (e) { console.error(`[vid#${scene.id}] DL échec: ${e.message}`); failed++; }
              }));
            } else if (item.status === "failed") {
              console.log(`FAIL vid#${scene.id}: ${item.error || ""}`);
              state.videos[item.id].failed = true; saveState(state); pending.delete(item.id);
              if (attempt < MAX_VIDEO_ATTEMPTS) {
                const imgFile = findExisting(IMG_DIR, scene.id, scene.section);
                if (imgFile) scheduleVideo(scene, path.join(IMG_DIR, imgFile), attempt + 1); else failed++;
              } else failed++;
            }
          }
          const totalPages = body.total_pages ?? 1;
          if (page >= totalPages || items.length === 0) break;
          page++;
        }
      } catch (e) { console.warn(`[poll] ${e.message}`); }
    }
    const now = Date.now();
    for (const [tid, info] of [...pending.entries()]) {
      if (now - info.postedAt > STUCK_AFTER_MS) {
        state.videos[tid].stuck = true; saveState(state);
        console.log(`STUCK vid#${info.scene.id}`); pending.delete(tid);
      }
    }
    process.stdout.write(`\r[vid] done=${done} fail=${failed} pending=${pending.size} flight=${inFlight}        `);
    if (pending.size === 0 && inFlight === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");
  console.log(`\nVIDEOS_ONLY fini : ${done} OK, ${failed} fail.`);
}

// =============================================================================
// Mode RESUME — pas de POST, juste poll les tasks en cours
// =============================================================================
async function resumeMode(token, scenes, state, manifest) {
  // Use rollingPipeline mais avec rien à scheduler initialement (on resume tout).
  // Le code de rolling gère déjà le cas resume via existingImg/existingVid.
  await rollingPipeline(token, scenes, state, manifest);
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  ensureDirs();
  const token = loadGenaiproKey();
  const spec = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const state = loadState();
  const manifest = loadManifest();
  const scenes = selectScenes(spec, state);
  if (!scenes.length) { console.error("Aucune scène sélectionnée"); process.exit(1); }
  console.log(`Project: ${PROJECT_NAME}`);
  console.log(`Scènes: ${scenes.map((s) => s.id).join(", ")}`);
  console.log(`Concurrency: img=${IMAGE_CONCURRENCY} vid=${VIDEO_CONCURRENCY} dl=${DOWNLOAD_CONCURRENCY} | Rate: img=${IMAGE_RATE_PER_MIN} vid=${VIDEO_RATE_PER_MIN} hist=${HISTORY_RATE_PER_MIN}/min`);
  console.log(`Poll: ${POLL_INTERVAL_MS}ms | Stuck: ${Math.round(STUCK_AFTER_MS / 60000)}min | Max attempts: img=${MAX_IMAGE_ATTEMPTS} vid=${MAX_VIDEO_ATTEMPTS}`);
  console.log(`Auto-video-after-image: ${AUTO_VIDEO_AFTER_IMAGE}`);

  if (process.env.RESUME) return resumeMode(token, scenes, state, manifest);
  if (process.env.IMAGES_ONLY) return imagesOnly(token, scenes, state, manifest);
  if (process.env.VIDEOS_ONLY) return videosOnly(token, scenes, state, manifest);

  // Default : rolling pipeline (image + auto video)
  await rollingPipeline(token, scenes, state, manifest);
}

main().catch((e) => { console.error("ERROR:", e.message); console.error(e.stack); process.exit(1); });
