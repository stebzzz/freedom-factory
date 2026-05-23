#!/usr/bin/env node
// gen-galveston-t2v.mjs — pipeline GenAIPro Veo V2 text-to-video
// pour galveston_1900_veo3_prompts.json (146 scènes Veo3, T2V direct).
//
// Modes :
//   node scripts/gen-galveston-t2v.mjs                    # toutes les scènes
//   IDS=1,2,3 node scripts/gen-galveston-t2v.mjs          # filtre
//   RESUME=1 node scripts/gen-galveston-t2v.mjs           # poll tasks en cours
//   FAILED_ONLY=1 node scripts/gen-galveston-t2v.mjs      # re-POST failed
//   STUCK_ONLY=1 node scripts/gen-galveston-t2v.mjs       # re-POST stuck
//   REGEN=1 IDS=3,7 node scripts/gen-galveston-t2v.mjs    # force regen
//
// Robustesse : stream DL disque, state persistant, retry réseau + 429,
// per-task stuck watchdog, retry up to MAX_ATTEMPTS, rate limit séparé.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, createWriteStream } from "fs";
import { stat, unlink, rename } from "fs/promises";
import { pipeline } from "stream/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROJECT_NAME = process.env.PROJECT_NAME || "galveston_1900_veo3";
const PROMPTS_PATH = process.env.PROMPTS_PATH || path.join(ROOT, `${PROJECT_NAME}_prompts.json`);
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_NAME);
const CLIP_DIR = path.join(OUT_DIR, "clips");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const STATE_PATH = path.join(OUT_DIR, "state.json");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ASPECT_VID = process.env.VIDEO_ASPECT_RATIO || "VIDEO_ASPECT_RATIO_LANDSCAPE";

const VIDEO_CONCURRENCY = parseInt(process.env.VIDEO_CONCURRENCY || "8", 10);
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY || "5", 10);
const VIDEO_RATE_PER_MIN = parseInt(process.env.VIDEO_RATE_PER_MIN || "29", 10);
const HISTORY_RATE_PER_MIN = parseInt(process.env.HISTORY_RATE_PER_MIN || "29", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "12000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || "1800000", 10);
const STUCK_AFTER_MS = parseInt(process.env.STUCK_AFTER_MS || "720000", 10);
const MAX_VIDEO_ATTEMPTS = parseInt(process.env.MAX_VIDEO_ATTEMPTS || "2", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- utils ----
function pLimit(concurrency) {
  let running = 0; const queue = [];
  const next = () => {
    if (running >= concurrency || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { running--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
function makeRateLimiter(perMinute) {
  const interval = 60_000 / perMinute; let last = 0;
  return async () => {
    const now = Date.now(); const wait = last + interval - now;
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
          await sleep(delay);
          return attempt(n - 1, Math.min(delay * 2, 60_000));
        }
        throw new Error(`HTTP ${res.statusCode} downloading ${target}`);
      }
      const tmpPath = `${outputPath}.tmp`;
      await pipeline(res, createWriteStream(tmpPath));
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

function extFromUrl(u, fallback) {
  const m = u.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : fallback;
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

// ---- API : text-to-video ----
async function postTextToVideo(token, prompt) {
  const body = JSON.stringify({
    prompt,
    aspect_ratio: ASPECT_VID,
    number_of_videos: 1,
  });
  const res = await httpsRequest("POST", `${API_BASE}/v2/veo/text-to-video`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  }, body);
  if (res.status !== 202)
    throw new Error(`text-to-video ${res.status}: ${res.body.toString("utf-8").slice(0, 400)}`);
  const data = JSON.parse(res.body.toString("utf-8"));
  const history = data.histories?.[0];
  if (!history) throw new Error("text-to-video: no history");
  return history;
}

// ---- persistence ----
function ensureDirs() { for (const d of [OUT_DIR, CLIP_DIR]) mkdirSync(d, { recursive: true }); }
function loadJSON(p, fallback) { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : fallback; }
function saveJSON(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2)); }
function loadManifest() { return loadJSON(MANIFEST_PATH, { project: PROJECT_NAME, created_at: Date.now(), updated_at: Date.now(), entries: [] }); }
function saveManifest(m) { m.updated_at = Date.now(); saveJSON(MANIFEST_PATH, m); }
function loadState() { return loadJSON(STATE_PATH, { videos: {} }); }
function saveState(s) { saveJSON(STATE_PATH, s); }

function findExistingClip(scene) {
  if (!existsSync(CLIP_DIR)) return null;
  const prefix = `${String(scene.id).padStart(3, "0")}_${slug(scene.section)}.`;
  return readdirSync(CLIP_DIR).find((f) => f.startsWith(prefix));
}

function selectScenes(spec, state) {
  let scenes = spec.scenes;
  if (process.env.IDS) {
    const wanted = process.env.IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
    scenes = scenes.filter((s) => wanted.includes(s.id));
  }
  if (process.env.FAILED_ONLY) {
    const ids = new Set(Object.values(state.videos).filter((v) => v.failed).map((v) => v.id));
    scenes = scenes.filter((s) => ids.has(s.id));
  }
  if (process.env.STUCK_ONLY) {
    const ids = new Set(Object.values(state.videos).filter((v) => v.stuck).map((v) => v.id));
    scenes = scenes.filter((s) => ids.has(s.id));
  }
  return scenes;
}

// ---- pipeline ----
async function runPipeline(token, scenes, state, manifest) {
  const videoRate = makeRateLimiter(VIDEO_RATE_PER_MIN);
  const historyRate = makeRateLimiter(HISTORY_RATE_PER_MIN);
  const postLimit = pLimit(VIDEO_CONCURRENCY);
  const dlLimit = pLimit(DOWNLOAD_CONCURRENCY);

  // pending: taskId -> { scene, postedAt, attempt }
  const pending = new Map();
  let inFlight = 0;
  const tracked = (p) => { inFlight++; p.finally(() => inFlight--); return p; };
  let done = 0, failed = 0, stuck = 0;

  const scheduleVideo = (scene, attempt = 1) => {
    if (attempt > MAX_VIDEO_ATTEMPTS) {
      console.log(`[t2v#${scene.id}] MAX_VIDEO_ATTEMPTS atteint — abandon`);
      failed++;
      return;
    }
    return tracked(postLimit(async () => {
      try {
        await videoRate();
        const history = await postTextToVideo(token, scene.video_prompt);
        console.log(`[t2v#${scene.id}] task ${history.id} (attempt ${attempt})`);
        state.videos[history.id] = { id: scene.id, section: scene.section, postedAt: Date.now(), downloaded: false, attempt };
        saveState(state);
        pending.set(history.id, { scene, postedAt: Date.now(), attempt });
      } catch (e) {
        console.error(`[t2v#${scene.id}] POST échec: ${e.message}`);
        failed++;
      }
    }));
  };

  // Initial scheduling
  for (const scene of scenes) {
    if (findExistingClip(scene) && !process.env.REGEN) continue;
    if (process.env.REGEN && findExistingClip(scene)) {
      const ex = findExistingClip(scene);
      await unlink(path.join(CLIP_DIR, ex)).catch(() => {});
      for (const tid of Object.keys(state.videos)) if (state.videos[tid].id === scene.id) delete state.videos[tid];
      saveState(state);
    }
    // resume : task already posted, not downloaded, not failed
    const existing = Object.entries(state.videos).find(([, v]) => v.id === scene.id && !v.downloaded && !v.failed);
    if (existing) {
      const [tid, v] = existing;
      pending.set(tid, { scene, postedAt: v.postedAt || Date.now(), attempt: v.attempt || 1 });
      console.log(`[resume t2v#${scene.id}] task ${tid}`);
      continue;
    }
    scheduleVideo(scene, 1);
  }

  // Download handler
  const downloadAndProcess = async (taskId, scene, url) => {
    const ext = extFromUrl(url, "mp4");
    const fname = `${String(scene.id).padStart(3, "0")}_${slug(scene.section)}.${ext}`;
    const fpath = path.join(CLIP_DIR, fname);
    try {
      const size = await streamDownload(url, fpath);
      console.log(`OK t2v#${scene.id} -> ${path.relative(ROOT, fpath)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      state.videos[taskId].downloaded = true;
      state.videos[taskId].path = fpath;
      saveState(state);
      const entry = manifest.entries.find((e) => e.id === scene.id) || (() => { const e = { id: scene.id, section: scene.section, scene_tag: scene.scene_tag, title: scene.title }; manifest.entries.push(e); return e; })();
      entry.video = { taskId, url, path: fpath, attempt: state.videos[taskId].attempt || 1 };
      saveManifest(manifest);
      done++;
    } catch (e) {
      console.error(`[t2v#${scene.id}] DL échec: ${e.message}`);
      await unlink(`${fpath}.tmp`).catch(() => {});
      failed++;
    }
  };

  // Polling loop
  const start = Date.now();
  let cycle = 0;
  while (true) {
    if (pending.size === 0 && inFlight === 0) {
      await sleep(300);
      if (pending.size === 0 && inFlight === 0) break;
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      console.log(`\n[poll] timeout global (${POLL_TIMEOUT_MS / 1000}s)`);
      break;
    }
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
            const { scene, attempt } = pending.get(item.id);
            if (item.status === "completed") {
              const url = item.file_urls?.[0];
              if (!url) {
                state.videos[item.id].failed = true; saveState(state);
                pending.delete(item.id);
                failed++;
                continue;
              }
              state.videos[item.id].url = url;
              state.videos[item.id].completedAt = Date.now();
              saveState(state);
              pending.delete(item.id);
              tracked(dlLimit(() => downloadAndProcess(item.id, scene, url)));
            } else if (item.status === "failed") {
              const errMsg = item.error || "(no msg)";
              console.log(`FAIL t2v#${scene.id}: ${errMsg}`);
              state.videos[item.id].failed = true;
              state.videos[item.id].error = errMsg;
              saveState(state);
              pending.delete(item.id);
              if (attempt < MAX_VIDEO_ATTEMPTS) scheduleVideo(scene, attempt + 1);
              else failed++;
            }
          }
          const totalPages = body.total_pages ?? 1;
          if (page >= totalPages || items.length === 0) break;
          page++;
        }
      } catch (e) { console.warn(`[poll] ${e.message}`); }
    }

    // stuck watchdog
    const now = Date.now();
    for (const [tid, info] of [...pending.entries()]) {
      if (now - info.postedAt > STUCK_AFTER_MS) {
        state.videos[tid].stuck = true; saveState(state);
        console.log(`STUCK t2v#${info.scene.id}`);
        pending.delete(tid);
        stuck++;
      }
    }

    process.stdout.write(`\r[t2v] done=${done} fail=${failed} stuck=${stuck} pending=${pending.size} flight=${inFlight} (c${++cycle})        `);
    if (pending.size === 0 && inFlight === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");

  console.log(`\n=== RECAP ===`);
  console.log(`OK : ${done}`);
  console.log(`Failed : ${failed}`);
  console.log(`Stuck : ${stuck}  (relance avec STUCK_ONLY=1)`);
  console.log(`State : ${path.relative(ROOT, STATE_PATH)}`);
  console.log(`Manifest : ${path.relative(ROOT, MANIFEST_PATH)}`);
}

async function main() {
  ensureDirs();
  const token = loadGenaiproKey();
  const spec = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const state = loadState();
  const manifest = loadManifest();
  const scenes = selectScenes(spec, state);
  if (!scenes.length) { console.error("Aucune scène sélectionnée"); process.exit(1); }
  console.log(`Project: ${PROJECT_NAME}  (T2V via /v2/veo/text-to-video)`);
  console.log(`Scènes: ${scenes.length} (${scenes.map((s) => s.id).slice(0, 20).join(",")}${scenes.length > 20 ? "…" : ""})`);
  console.log(`Concurrency=${VIDEO_CONCURRENCY} dl=${DOWNLOAD_CONCURRENCY} | Rate vid=${VIDEO_RATE_PER_MIN}/min hist=${HISTORY_RATE_PER_MIN}/min`);
  console.log(`Poll: ${POLL_INTERVAL_MS}ms | Stuck: ${Math.round(STUCK_AFTER_MS / 60000)}min | Max attempts: ${MAX_VIDEO_ATTEMPTS}`);
  await runPipeline(token, scenes, state, manifest);
}

main().catch((e) => { console.error("ERROR:", e.message); console.error(e.stack); process.exit(1); });
