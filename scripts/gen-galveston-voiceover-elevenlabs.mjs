#!/usr/bin/env node
// gen-galveston-voiceover-elevenlabs.mjs — appel direct ElevenLabs
// (POST /v1/text-to-speech/{voice_id}) au lieu de passer par GenAIPro.
// Garde le découpage par phrases et la concat ffmpeg du script GenAIPro.
//
// Usage :
//   node scripts/gen-galveston-voiceover-elevenlabs.mjs
//   VOICE_ID=ZoiZ8fuDWInAcwPXaVeq MODEL=eleven_multilingual_v2 \
//     CHUNK_CHARS=4500 SCRIPT=script-galveston-doc.txt \
//     node scripts/gen-galveston-voiceover-elevenlabs.mjs

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

const API_HOST = "api.elevenlabs.io";

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
  const env = loadEnvLocal();
  const k = process.env.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY;
  if (!k) { console.error("ELEVENLABS_API_KEY manquante."); process.exit(1); }
  return k;
}

function ttsRequest(apiKey, text) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: {
        stability: STABILITY,
        similarity_boost: SIMILARITY,
        style: STYLE,
        use_speaker_boost: true,
        speed: SPEED,
      },
    }));
    const req = https.request({
      hostname: API_HOST,
      path: `/v1/text-to-speech/${VOICE_ID}`,
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
        "Content-Length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString("utf-8").slice(0, 600)}`));
        }
        resolve(buf);
      });
    });
    req.on("error", reject);
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error("TTS request timeout")); });
    req.write(body);
    req.end();
  });
}

// Découpe en chunks ≤ maxChars, en respectant les frontières de phrases.
function chunkText(text, maxChars) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences = [];
  for (const p of paragraphs) {
    const parts = p.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [p];
    for (const s of parts) sentences.push(s.trim());
  }
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
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
  const apiKey = loadKey();
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
    process.stdout.write(`[chunk ${i + 1}/${chunks.length}] TTS… `);
    const t0 = Date.now();
    const buf = await ttsRequest(apiKey, chunks[i]);
    await writeFile(partPath, buf);
    console.log(`OK ${(buf.length / 1024).toFixed(0)} KB en ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(ROOT, partPath)}`);
    partPaths.push(partPath);
    await sleep(500);
  }

  const listFile = path.join(OUT_DIR, "concat.txt");
  await writeFile(listFile, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const finalPath = path.join(OUT_DIR, "galveston-doc.mp3");
  await ffmpegConcat(listFile, finalPath);
  await unlink(listFile).catch(() => {});
  console.log(`\nFINAL -> ${path.relative(ROOT, finalPath)}`);
}

main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
