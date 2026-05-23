#!/usr/bin/env node
// animate-genaipro-revolution.mjs — anime les scènes de "Je vlog la Révolution
// française" via GenAIPro Veo3 ingredients-to-video, avec un visage de
// référence unique injecté dans CHAQUE génération pour la cohérence.
//
// Source des prompts : Revolution_Francaise_Veo3_Prompts_Part2.txt
// Visage : public/style-refs/revolution_anchor.png
// Sortie : public/generated/revolution_francaise/clips/
//
// Usage :
//   ROWS=11,12 node scripts/animate-genaipro-revolution.mjs       # test 2 scènes
//   node scripts/animate-genaipro-revolution.mjs                  # toutes manquantes
//   FORCE=1 node scripts/animate-genaipro-revolution.mjs          # re-anime
//   CONCURRENCY=10 RATE_PER_MIN=25 POLL_INTERVAL_MS=15000
//
// Pattern : recopié d'animate-genaipro-earth.mjs (multipart, polling collectif
// /v2/veo/histories), mais POST sur /v2/veo/ingredients-to-video avec
// reference_images (multi) au lieu de start_image (single).

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROMPTS_TXT = process.env.PROMPTS_TXT
  || "/Users/stephanezayat/Downloads/Revolution_Francaise_Veo3_Prompts_Part2 (2).txt";
const REF_IMAGE = process.env.REF_IMAGE
  ? (path.isAbsolute(process.env.REF_IMAGE) ? process.env.REF_IMAGE : path.join(ROOT, process.env.REF_IMAGE))
  : path.join(ROOT, "public/style-refs/revolution_anchor.png");
const PROJECT_SLUG = process.env.PROJECT_SLUG || "revolution_francaise";
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_SLUG);
const CLIP_DIR = path.join(OUT_DIR, "clips");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const PROMPTS_JSON_PATH = path.join(OUT_DIR, "prompts.json");
const PENDING_PATH = path.join(OUT_DIR, "pending.json");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ASPECT_VID = "VIDEO_ASPECT_RATIO_LANDSCAPE";

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "8", 10);
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || "25", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || "1800000", 10);

// Fallback character block (utilisé si le PROMPTS_TXT n'a pas sa propre
// section "CHARACTER BLOCK"). L'image de référence porte le reste.
const FALLBACK_CHARACTER_BLOCK = "a young French woman in her late twenties with brown hair pinned up, fair skin, large expressive dark eyes, wearing period-accurate French Revolution-era clothing including a dark wool coat or bodice over a white ruffled fichu at the neck, matching the attached reference photo exactly — same face, same hair, same look";

// Parse une section "CHARACTER BLOCK" depuis le fichier prompts.
// Pattern : header "CHARACTER BLOCK ..." suivi de ===== puis contenu jusqu'au
// prochain ===== ou section ACT/SCENE.
function parseCharacterBlock(raw) {
  const m = raw.match(/CHARACTER BLOCK[^\n]*\n=+\n([\s\S]+?)\n=+/);
  if (!m) return null;
  const block = m[1].trim().replace(/\s+/g, " ");
  if (block.length < 50) return null;
  return block;
}

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
  if (!k) { console.error("GENAIPRO_API_KEY manquante (.env.local)"); process.exit(1); }
  return k;
}

function parsePrompts(txtPath) {
  const raw = readFileSync(txtPath, "utf-8");
  const characterBlock = parseCharacterBlock(raw) || FALLBACK_CHARACTER_BLOCK;
  // On découpe sur "SCENE N — title" qui sert d'ancre, puis on prend le bloc
  // de prompt jusqu'au prochain "SCENE N" (ou fin de fichier / "END OF").
  const headerRe = /^SCENE\s+(\d+)\s+[—\-]\s+(.+)$/gm;
  const matches = [];
  let m;
  while ((m = headerRe.exec(raw))) {
    matches.push({ n: parseInt(m[1], 10), title: m[2].trim(), headerStart: m.index, headerEnd: m.index + m[0].length });
  }
  const scenes = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    // Le body commence après la ligne VO (souvent juste après le header) ;
    // on saute la ligne "VO: ..." et la ligne de tirets de fermeture, et on
    // prend tout jusqu'au header suivant.
    const sliceEnd = next ? next.headerStart : raw.length;
    let block = raw.slice(cur.headerEnd, sliceEnd);
    // Trim leading VO: line and the separator lines made of dashes.
    block = block
      .split(/\r?\n/)
      .filter((line) => !/^VO:\s*/i.test(line) && !/^-{5,}\s*$/.test(line) && !/^={5,}\s*$/.test(line))
      .join("\n")
      .trim();
    // Cap any "END OF PROMPT SHEET" sentinel.
    block = block.replace(/END OF PROMPT SHEET[\s\S]*$/, "").trim();
    // Inject character block.
    block = block.replace(/\[PASTE FULL CHARACTER BLOCK\]/g, characterBlock);
    scenes.push({ n: cur.n, title: cur.title, prompt: block });
  }
  return scenes;
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

async function ingredientsToVideo(token, refBuffer, refName, prompt) {
  const detected = detectImageType(refBuffer);
  const baseName = refName.replace(/\.[^.]+$/, "");
  const properName = `${baseName}.${detected.ext}`;
  const { body, contentType } = buildMultipart([
    ["reference_images", { filename: properName, contentType: detected.mime, buffer: refBuffer }],
    ["prompt", prompt],
    ["aspect_ratio", ASPECT_VID],
    ["number_of_videos", "1"],
  ]);
  const res = await httpsRequest("POST", `${API_BASE}/v2/veo/ingredients-to-video`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "Content-Length": body.length,
  }, body);
  if (res.status !== 202) {
    throw new Error(`ingredients-to-video ${res.status}: ${res.body.toString("utf-8").slice(0, 500)}`);
  }
  const data = JSON.parse(res.body.toString("utf-8"));
  const history = data.histories?.[0];
  if (!history) throw new Error("ingredients-to-video: no history in response");
  return history;
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

function listExistingClipRows() {
  if (!existsSync(CLIP_DIR)) return new Set();
  const out = new Set();
  for (const f of readdirSync(CLIP_DIR)) {
    const m = f.match(/^(\d+)_/);
    if (m) out.add(parseInt(m[1], 10));
  }
  return out;
}

async function main() {
  if (!existsSync(PROMPTS_TXT)) throw new Error(`PROMPTS_TXT introuvable: ${PROMPTS_TXT}`);
  if (!existsSync(REF_IMAGE)) throw new Error(`REF_IMAGE introuvable: ${REF_IMAGE}`);
  mkdirSync(CLIP_DIR, { recursive: true });

  const token = loadGenaiproKey();
  const refBuffer = await readFile(REF_IMAGE);
  const refName = path.basename(REF_IMAGE);

  const scenes = parsePrompts(PROMPTS_TXT);
  // Persiste les prompts parsés pour inspection.
  writeFileSync(PROMPTS_JSON_PATH, JSON.stringify(scenes, null, 2));
  console.log(`Prompts parsés : ${scenes.length} scènes (n=${scenes[0]?.n}..${scenes.at(-1)?.n})`);
  console.log(`Prompts JSON   : ${path.relative(ROOT, PROMPTS_JSON_PATH)}`);

  const existingClips = listExistingClipRows();
  const force = !!process.env.FORCE;

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
    if (!scene) { console.warn(`[skip] scene ${n}: pas dans le fichier`); continue; }
    if (!force && existingClips.has(n)) { skipped.push(n); continue; }
    queue.push(scene);
  }

  if (skipped.length) console.log(`[skip] clips déjà présents: ${skipped.join(", ")}`);
  if (!queue.length) { console.log("Rien à animer."); return; }

  console.log(`Animation: ${queue.length} scène(s) (concurrency=${CONCURRENCY}, rate=${RATE_PER_MIN}/min, poll=${POLL_INTERVAL_MS}ms)`);
  console.log(`Scènes: ${queue.map((q) => q.n).join(", ")}`);
  console.log(`Visage ref: ${path.relative(ROOT, REF_IMAGE)}`);

  const manifest = loadManifest();
  const pending = loadPending(); // { [taskId]: { n, title } }
  const limit = pLimit(CONCURRENCY);
  const acquireRate = makeRateLimiter(RATE_PER_MIN);

  // Pré-remplit taskMap depuis pending.json pour les rows demandées : on
  // récupère gratuitement les jobs déjà soumis et pas encore téléchargés.
  const taskMap = new Map();
  const wantedSet = new Set(queue.map((q) => q.n));
  const recovered = [];
  for (const [taskId, meta] of Object.entries(pending)) {
    if (wantedSet.has(meta.n)) {
      const scene = queue.find((q) => q.n === meta.n);
      if (scene) {
        taskMap.set(taskId, scene);
        recovered.push(meta.n);
      }
    }
  }
  if (recovered.length) console.log(`Repris depuis pending.json (pas de re-POST): ${recovered.join(", ")}`);
  const toPost = queue.filter((q) => !recovered.includes(q.n));

  // Phase POST (uniquement scènes pas encore soumises)
  if (toPost.length) {
    const t0 = Date.now();
    const submitted = await Promise.all(toPost.map((q) => limit(async () => {
      await acquireRate();
      try {
        const history = await ingredientsToVideo(token, refBuffer, refName, q.prompt);
        console.log(`[vid#${q.n}] task ${history.id}`);
        // Persiste tout de suite pour pouvoir resume si crash.
        pending[history.id] = { n: q.n, title: q.title };
        savePending(pending);
        return { ...q, taskId: history.id };
      } catch (e) {
        console.error(`[vid#${q.n}] POST échec: ${e.message}`);
        return { ...q, taskId: null, error: e.message };
      }
    })));
    for (const s of submitted) if (s.taskId) taskMap.set(s.taskId, s);
    if (!taskMap.size) throw new Error("Aucun POST ingredients-to-video accepté");
    console.log(`POST OK: ${submitted.filter((s) => s.taskId).length}/${toPost.length} en ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // Polling + download inline (au fil de l'eau)
  const downloaded = [], failedN = [];
  const onComplete = async (item) => {
    const q = taskMap.get(item.id);
    if (!q) return;
    if (item.status === "failed") {
      console.error(`FAIL vid#${q.n} (crédits remboursés)`);
      failedN.push(q.n);
      delete pending[item.id]; savePending(pending);
      return;
    }
    const url = item.file_urls?.[0];
    if (!url) { failedN.push(q.n); delete pending[item.id]; savePending(pending); return; }
    try {
      const buf = await httpsDownload(url);
      const ext = extFromUrl(url, "mp4");
      const fname = `${String(q.n).padStart(2, "0")}_${slug(q.title)}.${ext}`;
      const fpath = path.join(CLIP_DIR, fname);
      await writeFile(fpath, buf);
      console.log(`OK vid#${q.n} -> ${path.relative(ROOT, fpath)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      const entry = manifest.entries.find((e) => e.n === q.n);
      if (entry) entry.video = { taskId: item.id, url, path: fpath, title: q.title };
      else manifest.entries.push({ n: q.n, title: q.title, video: { taskId: item.id, url, path: fpath } });
      saveManifest(manifest);
      delete pending[item.id]; savePending(pending);
      downloaded.push(q.n);
    } catch (e) {
      console.error(`[vid#${q.n}] DL échec: ${e.message}`);
      failedN.push(q.n);
    }
  };

  const results = await pollHistoriesUntilDone(token, [...taskMap.keys()], "vid-poll", onComplete);

  // Scènes qui n'ont jamais terminé (timeout poll)
  const stuckN = [];
  for (const [taskId, q] of taskMap.entries()) {
    if (!results.has(taskId)) stuckN.push(q.n);
  }

  console.log("\n=== RECAP ===");
  console.log(`OK (${downloaded.length}): ${downloaded.sort((a, b) => a - b).join(", ") || "—"}`);
  if (failedN.length) console.log(`FAILED côté Veo (${failedN.length}, crédits remboursés): ${failedN.sort((a, b) => a - b).join(", ")}`);
  if (stuckN.length) console.log(`TIMEOUT (${stuckN.length}, gardés dans pending.json pour resume): ${stuckN.sort((a, b) => a - b).join(", ")}`);
  console.log(`Manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
