#!/usr/bin/env node
// gen-galveston-voiceover.mjs — TTS via GenAIPro Labs (POST /api/v1/labs/task,
// poll GET /api/v1/labs/task/{id}). Chunke le script à ~4500 chars sur les
// frontières de phrase puis concatène les mp3 via ffmpeg.
//
// Usage :
//   GENAIPRO_TOKEN="eyJ..." node scripts/gen-galveston-voiceover.mjs
//   VOICE_ID=ZoiZ8fuDWInAcwPXaVeq MODEL=eleven_multilingual_v2 \
//     CHUNK_CHARS=4500 SCRIPT=script-galveston-doc.txt \
//     node scripts/gen-galveston-voiceover.mjs

import { existsSync, readFileSync, mkdirSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCRIPT_PATH = path.join(ROOT, process.env.SCRIPT || "script-galveston-doc.txt");
const OUT_DIR = path.join(ROOT, "public/generated/galveston_1900_veo3/voiceover");
const VOICE_ID = process.env.VOICE_ID || "ZoiZ8fuDWInAcwPXaVeq";
const MODEL_ID = process.env.MODEL || "eleven_multilingual_v2";
const CHUNK_CHARS = parseInt(process.env.CHUNK_CHARS || "4500", 10);
const STABILITY = parseFloat(process.env.STABILITY || "0.5");
const SIMILARITY = parseFloat(process.env.SIMILARITY || "0.75");
const STYLE = parseFloat(process.env.STYLE || "0");
const SPEED = parseFloat(process.env.SPEED || "1");

const API_HOST = "genaipro.io";
const API_BASE = "/api";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

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
function loadToken() {
  const env = loadEnvLocal();
  const k = process.env.GENAIPRO_TOKEN || process.env.GENAIPRO_API_KEY || env.GENAIPRO_API_KEY;
  if (!k) { console.error("GENAIPRO_TOKEN/GENAIPRO_API_KEY manquante."); process.exit(1); }
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
    req.setTimeout(180_000, () => { req.destroy(); reject(new Error(`HTTP ${method} timeout`)); });
    if (body) req.write(body);
    req.end();
  });
}

function httpsDownload(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "FreedomFactory/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Découpe en chunks ≤ maxChars, en respectant les frontières de phrases.
function chunkText(text, maxChars) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences = [];
  for (const p of paragraphs) {
    // split sur ponctuation forte (. ! ?) suivie d'espace ou newline
    const parts = p.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [p];
    for (const s of parts) sentences.push(s.trim());
  }
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      // phrase trop longue : split brut sur virgule
      if (cur) { chunks.push(cur); cur = ""; }
      const subs = s.split(/(?<=,)\s+/);
      let buf = "";
      for (const sub of subs) {
        if (buf.length + sub.length + 1 > maxChars) {
          if (buf) chunks.push(buf);
          buf = sub;
        } else {
          buf = buf ? `${buf} ${sub}` : sub;
        }
      }
      if (buf) chunks.push(buf);
      continue;
    }
    if (cur.length + s.length + 1 > maxChars) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function createTtsTask(token, input) {
  const body = Buffer.from(JSON.stringify({
    input,
    voice_id: VOICE_ID,
    model_id: MODEL_ID,
    stability: STABILITY,
    similarity: SIMILARITY,
    style: STYLE,
    speed: SPEED,
    use_speaker_boost: true,
  }));
  const res = await httpsRequest("POST", `${API_BASE}/v1/labs/task`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": body.length,
  }, body);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`labs/task POST ${res.status}: ${res.body.toString("utf-8").slice(0, 600)}`);
  }
  const data = JSON.parse(res.body.toString("utf-8"));
  if (!data.task_id) throw new Error(`labs/task POST: no task_id (${JSON.stringify(data).slice(0, 300)})`);
  return data.task_id;
}

async function pollTask(token, taskId) {
  const start = Date.now();
  while (true) {
    if (Date.now() - start > POLL_TIMEOUT_MS) throw new Error(`poll timeout for ${taskId}`);
    const res = await httpsRequest("GET",
      `${API_BASE}/v1/labs/task/${taskId}`,
      { Authorization: `Bearer ${token}` });
    if (res.status === 429) {
      const txt = res.body.toString("utf-8");
      const m = txt.match(/(\d+)\s*Seconds?/i);
      const wait = m ? Math.max(parseInt(m[1], 10), 5) * 1000 : 15000;
      process.stdout.write(`\n[${taskId.slice(0, 8)}] 429 -> sleep ${wait / 1000}s\n`);
      await sleep(wait);
      continue;
    }
    if (res.status !== 200) throw new Error(`labs/task GET ${res.status}: ${res.body.toString("utf-8").slice(0, 300)}`);
    const data = JSON.parse(res.body.toString("utf-8"));
    if (data.status === "completed") return data;
    if (data.status === "failed" || data.status === "error") {
      throw new Error(`task ${taskId} failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function ffmpegConcat(listFile, outFile) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFile];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });
}

async function main() {
  if (!existsSync(SCRIPT_PATH)) { console.error(`Script introuvable: ${SCRIPT_PATH}`); process.exit(1); }
  const token = loadToken();
  mkdirSync(OUT_DIR, { recursive: true });

  const text = readFileSync(SCRIPT_PATH, "utf-8").trim();
  const chunks = chunkText(text, CHUNK_CHARS);
  console.log(`Script: ${text.length} chars -> ${chunks.length} chunk(s) (max ${CHUNK_CHARS})`);
  chunks.forEach((c, i) => console.log(`  chunk ${i + 1}: ${c.length} chars`));

  const partPaths = [];
  for (let i = 0; i < chunks.length; i++) {
    const idx = String(i + 1).padStart(2, "0");
    const partPath = path.join(OUT_DIR, `part_${idx}.mp3`);
    if (existsSync(partPath) && !process.env.FORCE) {
      console.log(`[chunk ${i + 1}/${chunks.length}] déjà présent: ${path.relative(ROOT, partPath)} (skip)`);
      partPaths.push(partPath);
      continue;
    }
    process.stdout.write(`[chunk ${i + 1}/${chunks.length}] POST… `);
    const taskId = await createTtsTask(token, chunks[i]);
    process.stdout.write(`task ${taskId.slice(0, 8)}, polling… `);
    const result = await pollTask(token, taskId);
    const url = result.result;
    if (!url) throw new Error(`chunk ${i + 1}: no result url (${JSON.stringify(result).slice(0, 200)})`);
    const buf = await httpsDownload(url);
    await writeFile(partPath, buf);
    console.log(`OK ${(buf.length / 1024).toFixed(0)} KB -> ${path.relative(ROOT, partPath)}`);
    partPaths.push(partPath);
    await sleep(800); // léger throttle entre chunks
  }

  // Concat
  const listFile = path.join(OUT_DIR, "concat.txt");
  await writeFile(listFile, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const finalPath = path.join(OUT_DIR, "galveston-doc.mp3");
  await ffmpegConcat(listFile, finalPath);
  await unlink(listFile).catch(() => {});
  console.log(`\nFINAL -> ${path.relative(ROOT, finalPath)}`);
}

main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
