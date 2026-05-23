#!/usr/bin/env node
// sticky-image-pipeline.mjs — pipeline standalone pour le mode "sticky"
// (slideshow 2D cartoon explainer, 1 image / segment ~3s, pas d'animation Veo).
//
// Flow:
//   1. Parse un .txt au format "IMAGE N — MM:SS–MM:SS / Prompt :"
//   2. POST chaque prompt sur GenAIPro /v2/veo/create-image (multipart)
//   3. Poll collectif /v2/veo/histories jusqu'a completed
//   4. Download les PNG dans public/generated/<slug>/images/
//   5. Concat ffmpeg en mp4 final (durées exactes des timestamps)
//
// Usage :
//   node scripts/sticky-image-pipeline.mjs                       # tout, defaults
//   PROMPTS_TXT=./sticktxt.txt PROJECT_SLUG=sticky_amnesia \
//     node scripts/sticky-image-pipeline.mjs
//   ROWS=1,2,3 node scripts/sticky-image-pipeline.mjs            # subset
//   FORCE=1 node scripts/sticky-image-pipeline.mjs               # re-genere
//   SKIP_MONTAGE=1 node scripts/sticky-image-pipeline.mjs        # images only
//   CONCURRENCY=8 RATE_PER_MIN=25 POLL_INTERVAL_MS=15000
//
// Patterns repris d'animate-genaipro-revolution.mjs (multipart, polling,
// CDN rewrite). Mais POST sur create-image (image) au lieu de
// ingredients-to-video (video), donc pas de reference_images obligatoires.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes, createHash } from "crypto";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// --- Config --------------------------------------------------------------
const PROMPTS_TXT = process.env.PROMPTS_TXT
  ? (path.isAbsolute(process.env.PROMPTS_TXT) ? process.env.PROMPTS_TXT : path.join(ROOT, process.env.PROMPTS_TXT))
  : path.join(ROOT, "sticktxt.txt");
const PROJECT_SLUG = process.env.PROJECT_SLUG || "sticky_infantile_amnesia";
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_SLUG);
const IMG_DIR = path.join(OUT_DIR, "images");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const PROMPTS_JSON_PATH = path.join(OUT_DIR, "prompts.json");
const PENDING_PATH = path.join(OUT_DIR, "pending.json");
const MONTAGE_PATH = path.join(OUT_DIR, "sticky.mp4");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ASPECT_IMG = "IMAGE_ASPECT_RATIO_LANDSCAPE";
const IMAGE_MODEL = process.env.GENAIPRO_IMAGE_MODEL || "nano_banana_pro";

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "8", 10);
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || "25", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || "1800000", 10);

const SKIP_MONTAGE = !!process.env.SKIP_MONTAGE;
const FORCE = !!process.env.FORCE;

// --- Helpers -------------------------------------------------------------
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
  const env = loadEnvLocal();
  const k = process.env.GENAIPRO_API_KEY || env.GENAIPRO_API_KEY || env.GENAIPRO_TOKEN;
  if (!k) { console.error("GENAIPRO_API_KEY manquante (.env.local)"); process.exit(1); }
  return k;
}

// --- Parser : 2 formats supportés ----------------------------------------
//   A. "IMAGE N — MM:SS–MM:SS" puis "Phrase :"/"Intention :"/"Prompt :" → durée
//      derivée des timestamps.
//   B. "IMAGE N — title libre" suivi directement du prompt anglais (multilignes)
//      → durée par défaut (DEFAULT_SEGMENT_DUR=3s).
// Un bloc d'en-tete style en haut du fichier (sans header IMAGE) est ignoré.
const DEFAULT_SEGMENT_DUR = parseInt(process.env.DEFAULT_SEGMENT_DUR || "3", 10);

function parsePromptsTxt(txtPath) {
  const raw = readFileSync(txtPath, "utf-8");
  if (!raw.trim()) {
    throw new Error(`PROMPTS_TXT vide: ${txtPath} (penser a sauvegarder dans l'IDE)`);
  }
  // Header regex with OPTIONAL timestamps. Captures: 1=n, 2..5=mm:ss-mm:ss (optional)
  const headerRe = /(?:^|\n)\s*#{0,4}\s*IMAGE\s+(\d+)\s*[—–\-]\s*(?:(\d{1,2}):(\d{2})\s*[–—\-]\s*(\d{1,2}):(\d{2}))?[^\n]*/gi;
  const headers = [];
  let m;
  while ((m = headerRe.exec(raw)) !== null) {
    const hasTs = m[2] !== undefined;
    headers.push({
      n: parseInt(m[1], 10),
      hasTs,
      startS: hasTs ? parseInt(m[2], 10) * 60 + parseInt(m[3], 10) : 0,
      endS: hasTs ? parseInt(m[4], 10) * 60 + parseInt(m[5], 10) : 0,
      bodyStart: m.index + m[0].length,
      bodyEnd: 0,
    });
  }
  if (headers.length === 0) throw new Error("Aucun bloc 'IMAGE N — ...' detecte dans le .txt");
  for (let i = 0; i < headers.length; i++) {
    headers[i].bodyEnd = i + 1 < headers.length ? headers[i + 1].bodyStart - 1 : raw.length;
  }

  const stripBold = (s) => s.replace(/\*\*/g, "").trim();
  const stripQuotes = (s) => s.replace(/^["“”'‘’«»\s]+/, "").replace(/["“”'‘’«»\s]+$/, "");
  const promptHeaderRe = /(?:\*\*)?\s*Prompt(?:\s+final(?:\s+en\s+anglais)?)?\s*(?:\*\*)?\s*:\s*\n?/i;

  return headers.map((h) => {
    const body = raw.slice(h.bodyStart, h.bodyEnd);
    let imagePrompt = "";
    const pm = body.match(promptHeaderRe);
    if (pm && pm.index !== undefined) {
      // Format A: take everything after "Prompt :" header.
      imagePrompt = body.slice(pm.index + pm[0].length);
    } else {
      // Format B: strip the optional Phrase/Intention meta lines (rare in this form)
      // and treat the rest of the body as the prompt directly.
      imagePrompt = body
        .split(/\r?\n/)
        .filter((line) =>
          !/^\s*(?:\*\*)?\s*Phrase(?:\s+du\s+script)?\s*(?:\*\*)?\s*:/i.test(line)
          && !/^\s*(?:\*\*)?\s*Intention(?:\s+visuelle)?\s*(?:\*\*)?\s*:/i.test(line),
        )
        .join("\n");
    }
    imagePrompt = stripQuotes(stripBold(imagePrompt)).trim();

    const phraseMatch = body.match(/(?:\*\*)?\s*Phrase(?:\s+du\s+script)?\s*(?:\*\*)?\s*:\s*([^\n]+)/i);
    const narration = phraseMatch ? stripQuotes(stripBold(phraseMatch[1])) : "";

    const dur = h.hasTs ? Math.max(1, h.endS - h.startS) : DEFAULT_SEGMENT_DUR;
    return { n: h.n, narration, imagePrompt, durationSeconds: dur };
  });
}

// --- HTTP ----------------------------------------------------------------
function buildMultipart(fields) {
  const boundary = `----GenAIPro${randomBytes(8).toString("hex")}`;
  const parts = [];
  for (const [name, value] of fields) {
    if (value && typeof value === "object" && value.filename) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n` +
        `Content-Type: ${value.contentType}\r\n\r\n`,
      ));
      parts.push(value.buffer);
      parts.push(Buffer.from("\r\n"));
    } else {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
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

function extFromUrl(u, fallback) {
  const m = u.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : fallback;
}

function detectImageMime(buf, filename) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

async function loadRefImageBuffers(paths) {
  if (paths.length > 5) throw new Error(`Max 5 reference_images (recu ${paths.length})`);
  const out = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`REF_IMAGE introuvable: ${p}`);
    const buf = await readFile(p);
    out.push({ buffer: buf, filename: path.basename(p), contentType: detectImageMime(buf, p) });
  }
  return out;
}

// Use native FormData (Node 18+) — exact same multipart shape as
// lib/api/genaipro.ts which is known to work with reference_images.
async function createImage(token, prompt, refBuffers) {
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("aspect_ratio", ASPECT_IMG);
  fd.append("number_of_images", "1");
  fd.append("model", IMAGE_MODEL);
  for (const r of refBuffers) {
    fd.append("reference_images", new Blob([new Uint8Array(r.buffer)], { type: r.contentType }), r.filename);
  }
  const res = await fetch(`https://${API_HOST}${API_BASE}/v2/veo/create-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`create-image ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error(`create-image: no id (${JSON.stringify(data).slice(0, 200)})`);
  return data;
}

// When refs are provided, the textual "Style:" descriptor in the user's prompt
// fights the visual style of the refs. We strip the style block and replace it
// with a hard-coded description of the EXACT style observed in the refs
// (pure stick-figure with no clothing color blocks, warm brown-red wooden
// furniture, off-white/grey near-empty background — NO pastels, NO colored
// walls). nano_banana_pro leans on textual cues, so we encode the refs in
// words as well as attach them.
const STICKY_STYLE_BLOCK = `Style: hand-drawn cartoon in a simple educational YouTube explainer style. Pure stick-figure bodies — characters drawn as a single thin black line for limbs and torso, NO clothing color blocks, NO outfits, NO pants, NO dresses. Round white heads with simple dot eyes and very expressive thin black eyebrows (often slightly lowered, half-closed eyes, a slightly bored or pensive look). Lines are slightly wobbly and hand-drawn, NOT polished vector. Color palette is strictly limited to: warm saturated brown-red wood tones for furniture (tables, chairs, desks, bookshelves), small accents of saturated mustard-yellow or saturated orange for light bulbs / sun, off-white or pale grey background walls, light cream floor. ABSOLUTELY NO pastel colors. NO blue walls. NO pink. NO bright tones. NO gradients. NO realistic shadows. NO textures. The background should feel near-empty: a flat off-white / pale grey wall area, a flat cream floor area, and a sparse set of meaningful objects placed around the character. One single clear scene, no split-screen, no collage, no panels. 16:9 horizontal frame.`;

function adjustPromptForRefs(prompt, hasRefs) {
  if (!hasRefs) return prompt;
  let scene = prompt;
  const sceneIdx = scene.search(/(?:^|\n)\s*Scene\s*:/i);
  if (sceneIdx >= 0) scene = scene.slice(sceneIdx).replace(/^\s*Scene\s*:\s*/i, "");
  scene = scene.replace(/16:9\s*horizontal\s*frame\.?\s*$/i, "").trim();
  return [
    "Replicate EXACTLY the visual style of the attached reference images. The reference images are the absolute style authority — copy their line quality, character anatomy, palette, and background simplicity literally.",
    "",
    STICKY_STYLE_BLOCK,
    "",
    `Scene: ${scene}`,
  ].join("\n");
}

async function pollHistoriesUntilDone(token, taskIds, label, onComplete) {
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
        if (item.status === "completed") {
          results.set(item.id, item); pending.delete(item.id); succeeded++;
          if (onComplete) { try { await onComplete(item); } catch (e) { console.error(`[${label}] onComplete err: ${e.message}`); } }
        } else if (item.status === "failed") {
          results.set(item.id, item); pending.delete(item.id); failed++;
          if (onComplete) { try { await onComplete(item); } catch (e) { console.error(`[${label}] onComplete err: ${e.message}`); } }
        }
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages) break;
      if (items.length === 0) break;
      page++;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[${label}] ok=${succeeded} fail=${failed} pending=${pending.size} (${elapsed}s, cycle ${++cycle})        \n`);
    if (pending.size === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return results;
}

// --- State persistence ---------------------------------------------------
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { entries: [] };
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}
function saveManifest(m) { writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }
function loadPending() {
  if (!existsSync(PENDING_PATH)) return {};
  try { return JSON.parse(readFileSync(PENDING_PATH, "utf-8")); } catch { return {}; }
}
function savePending(p) { writeFileSync(PENDING_PATH, JSON.stringify(p, null, 2)); }

function listExistingImageRows() {
  if (!existsSync(IMG_DIR)) return new Set();
  const out = new Set();
  for (const f of readdirSync(IMG_DIR)) {
    const m = f.match(/^(\d+)_/);
    if (m) out.add(parseInt(m[1], 10));
  }
  return out;
}

// --- Montage ffmpeg ------------------------------------------------------
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
    proc.on("error", reject);
    proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });
}

async function buildMontage(scenes) {
  // Build concat list: each image displayed for its durationSeconds.
  // Last entry MUST repeat the previous file (ffmpeg concat demuxer quirk).
  const lines = [];
  const ordered = scenes
    .slice()
    .sort((a, b) => a.n - b.n)
    .filter((s) => s.imagePath);
  if (ordered.length === 0) throw new Error("Aucune image disponible pour le montage");

  for (const s of ordered) {
    lines.push(`file '${s.imagePath.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${s.durationSeconds}`);
  }
  // Repeat last file without duration so it gets a final frame
  lines.push(`file '${ordered[ordered.length - 1].imagePath.replace(/'/g, "'\\''")}'`);
  const listPath = path.join(OUT_DIR, "concat.txt");
  writeFileSync(listPath, lines.join("\n"));

  const totalDur = ordered.reduce((a, b) => a + b.durationSeconds, 0);
  console.log(`Montage: ${ordered.length} images, ~${totalDur}s total -> ${path.relative(ROOT, MONTAGE_PATH)}`);

  await ffmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-vsync", "vfr",
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p,fps=30",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-movflags", "+faststart",
    MONTAGE_PATH,
  ]);
}

// --- Main ----------------------------------------------------------------
async function main() {
  if (!existsSync(PROMPTS_TXT)) throw new Error(`PROMPTS_TXT introuvable: ${PROMPTS_TXT}`);
  mkdirSync(IMG_DIR, { recursive: true });

  const token = loadGenaiproKey();
  let refPaths = (process.env.REF_IMAGES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Alternative: pass a directory, we'll pick every image inside.
  if (refPaths.length === 0 && process.env.REF_DIR) {
    const dir = path.isAbsolute(process.env.REF_DIR) ? process.env.REF_DIR : path.join(ROOT, process.env.REF_DIR);
    if (!existsSync(dir)) throw new Error(`REF_DIR introuvable: ${dir}`);
    refPaths = readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  }
  const refBuffers = refPaths.length > 0 ? await loadRefImageBuffers(refPaths) : [];
  if (refBuffers.length > 0) {
    console.log(`Refs style: ${refBuffers.length} image(s) — ${refBuffers.map((r) => r.filename).join(", ")}`);
  }
  const scenes = parsePromptsTxt(PROMPTS_TXT);
  writeFileSync(PROMPTS_JSON_PATH, JSON.stringify(scenes, null, 2));
  const totalDur = scenes.reduce((a, b) => a + b.durationSeconds, 0);
  console.log(`Prompts parses : ${scenes.length} images (~${totalDur}s) — n=${scenes[0]?.n}..${scenes.at(-1)?.n}`);
  console.log(`Project        : ${PROJECT_SLUG}  ->  ${path.relative(ROOT, OUT_DIR)}`);
  console.log(`Model image    : ${IMAGE_MODEL}`);

  const existing = listExistingImageRows();
  let wanted;
  if (process.env.ROWS) {
    wanted = process.env.ROWS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  } else {
    wanted = scenes.map((s) => s.n);
  }

  const queue = [];
  const skipped = [];
  for (const n of wanted) {
    const scene = scenes.find((s) => s.n === n);
    if (!scene) { console.warn(`[skip] image ${n}: pas dans le fichier`); continue; }
    if (!FORCE && existing.has(n)) { skipped.push(n); continue; }
    queue.push(scene);
  }
  if (skipped.length) console.log(`[skip] deja generees: ${skipped.join(", ")}`);

  // Existing entries that should be picked up for montage even if we didn't regenerate them.
  const allKnown = new Map(); // n -> { n, imagePath, durationSeconds, prompt }
  for (const n of existing) {
    const scene = scenes.find((s) => s.n === n);
    if (!scene) continue;
    const files = readdirSync(IMG_DIR).filter((f) => f.startsWith(`${String(n).padStart(3, "0")}_`));
    if (!files.length) continue;
    allKnown.set(n, { n, imagePath: path.join(IMG_DIR, files[0]), durationSeconds: scene.durationSeconds, prompt: scene.imagePrompt });
  }

  if (queue.length === 0) {
    console.log("Rien a generer.");
    if (!SKIP_MONTAGE) {
      const scenesForMontage = [...allKnown.values()];
      if (scenesForMontage.length > 0) await buildMontage(scenesForMontage);
    }
    return;
  }

  console.log(`Generation: ${queue.length} image(s) (concurrency=${CONCURRENCY}, rate=${RATE_PER_MIN}/min, poll=${POLL_INTERVAL_MS}ms)`);

  const manifest = loadManifest();
  const pending = loadPending();
  const limit = pLimit(CONCURRENCY);
  const acquireRate = makeRateLimiter(RATE_PER_MIN);

  // Recover any in-flight jobs from previous run.
  const taskMap = new Map();
  const wantedSet = new Set(queue.map((q) => q.n));
  const recovered = [];
  for (const [taskId, meta] of Object.entries(pending)) {
    if (wantedSet.has(meta.n)) {
      const scene = queue.find((q) => q.n === meta.n);
      if (scene) { taskMap.set(taskId, scene); recovered.push(meta.n); }
    }
  }
  if (recovered.length) console.log(`Repris depuis pending.json (pas de re-POST): ${recovered.join(", ")}`);
  const toPost = queue.filter((q) => !recovered.includes(q.n));

  // Phase POST
  if (toPost.length) {
    const t0 = Date.now();
    const submitted = await Promise.all(toPost.map((q) => limit(async () => {
      await acquireRate();
      try {
        const finalPrompt = adjustPromptForRefs(q.imagePrompt, refBuffers.length > 0);
        const data = await createImage(token, finalPrompt, refBuffers);
        console.log(`[img#${q.n}] task ${data.id}`);
        pending[data.id] = { n: q.n };
        savePending(pending);
        return { ...q, taskId: data.id };
      } catch (e) {
        console.error(`[img#${q.n}] POST echec: ${e.message}`);
        return { ...q, taskId: null, error: e.message };
      }
    })));
    for (const s of submitted) if (s.taskId) taskMap.set(s.taskId, s);
    if (!taskMap.size) throw new Error("Aucun POST create-image accepte");
    console.log(`POST OK: ${submitted.filter((s) => s.taskId).length}/${toPost.length} en ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // Polling + download inline
  const downloaded = [], failedN = [];
  const onComplete = async (item) => {
    const q = taskMap.get(item.id);
    if (!q) return;
    if (item.status === "failed") {
      console.error(`FAIL img#${q.n} (credits rembourses)`);
      failedN.push(q.n);
      delete pending[item.id]; savePending(pending);
      return;
    }
    const url = item.file_urls?.[0];
    if (!url) { failedN.push(q.n); delete pending[item.id]; savePending(pending); return; }
    try {
      const buf = await httpsDownload(url);
      const ext = extFromUrl(url, "png");
      const fname = `${String(q.n).padStart(3, "0")}_img.${ext}`;
      const fpath = path.join(IMG_DIR, fname);
      await writeFile(fpath, buf);
      console.log(`OK img#${q.n} -> ${path.relative(ROOT, fpath)} (${(buf.length / 1024).toFixed(0)} KB)`);
      const entry = manifest.entries.find((e) => e.n === q.n);
      if (entry) entry.image = { taskId: item.id, url, path: fpath, durationSeconds: q.durationSeconds };
      else manifest.entries.push({ n: q.n, image: { taskId: item.id, url, path: fpath, durationSeconds: q.durationSeconds } });
      saveManifest(manifest);
      delete pending[item.id]; savePending(pending);
      downloaded.push(q.n);
      allKnown.set(q.n, { n: q.n, imagePath: fpath, durationSeconds: q.durationSeconds, prompt: q.imagePrompt });
    } catch (e) {
      console.error(`[img#${q.n}] DL echec: ${e.message}`);
      failedN.push(q.n);
    }
  };

  await pollHistoriesUntilDone(token, [...taskMap.keys()], "img-poll", onComplete);

  // Stuck entries
  const stuckN = [];
  for (const [, q] of taskMap.entries()) {
    if (!downloaded.includes(q.n) && !failedN.includes(q.n)) stuckN.push(q.n);
  }

  console.log("\n=== RECAP IMAGES ===");
  console.log(`OK (${downloaded.length}): ${downloaded.sort((a, b) => a - b).join(", ") || "—"}`);
  if (failedN.length) console.log(`FAILED (${failedN.length}): ${failedN.sort((a, b) => a - b).join(", ")}`);
  if (stuckN.length) console.log(`TIMEOUT (${stuckN.length}): ${stuckN.sort((a, b) => a - b).join(", ")}`);

  // Montage
  if (SKIP_MONTAGE) {
    console.log("SKIP_MONTAGE=1 -> on s'arrete avant ffmpeg.");
    return;
  }
  const ready = [...allKnown.values()];
  const expected = scenes.length;
  if (ready.length < expected) {
    console.log(`Montage: ${ready.length}/${expected} images presentes — concat des disponibles uniquement.`);
  }
  if (ready.length === 0) {
    console.log("Aucune image disponible — montage saute.");
    return;
  }
  await buildMontage(ready);
  console.log(`\nMP4 final: ${path.relative(ROOT, MONTAGE_PATH)}`);
}

main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
