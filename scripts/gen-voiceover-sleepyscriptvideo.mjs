#!/usr/bin/env node
/**
 * Voiceover standalone — sleepyscriptvideo.txt -> sleepyscriptvideo.mp3
 *
 * Reuse de la logique de run-sleepy-job.mjs : chunk + ElevenLabs + ffmpeg concat.
 * Output: 1 seul fichier MP3.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "fs";
import { execSync } from "child_process";
import https from "https";
import path from "path";

const INPUT_PATH = "sleepyscriptvideo.txt";
const OUTPUT_PATH = "sleepyscriptvideo.mp3";
const API_KEY_PATH = "config/settings.json";
const TMP_DIR = "public/generated/_voiceover_sleepyscriptvideo";
const MAX_CHUNK_CHARS = 4000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunkText(text, maxChars = MAX_CHUNK_CHARS) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? " " : "") + sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function generateChunk(apiKey, voiceId, text) {
  const body = JSON.stringify({
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
  });
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: true, timeout: 600000 });
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${voiceId}`,
      method: "POST",
      agent,
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        "content-length": Buffer.byteLength(body).toString(),
        connection: "keep-alive",
      },
    }, res => {
      const parts = [];
      res.on("data", c => parts.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(parts);
        if (res.statusCode >= 400) reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString().slice(0, 300)}`));
        else resolve(buf);
      });
    });
    req.on("error", reject);
    req.on("socket", s => { s.setKeepAlive(true, 30000); s.setTimeout(600000); });
    req.setTimeout(600000, () => { req.destroy(); reject(new Error("ElevenLabs timeout 600s")); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const cfg = JSON.parse(readFileSync(API_KEY_PATH, "utf-8"));
  const apiKey = cfg.elevenlabsKey;
  const voiceId = cfg.elevenlabsVoiceId || "ErXwobaYiN019PkySvjV";
  if (!apiKey) { console.error("Pas de cle ElevenLabs dans config/settings.json"); process.exit(1); }

  const script = readFileSync(INPUT_PATH, "utf-8").trim();
  console.log(`Script: ${script.length} chars / ${script.split(/\s+/).length} mots`);
  console.log(`Voice ID: ${voiceId}`);

  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const chunks = chunkText(script);
  console.log(`${chunks.length} chunks (max ${MAX_CHUNK_CHARS} chars)`);

  const chunkPaths = [];
  for (let i = 0; i < chunks.length; i++) {
    const out = path.resolve(TMP_DIR, `chunk_${String(i).padStart(3, "0")}.mp3`);
    chunkPaths.push(out);
    if (existsSync(out) && statSync(out).size > 1000) {
      console.log(`  Chunk ${i + 1}/${chunks.length} (cache, ${(statSync(out).size / 1024).toFixed(0)} KB)`);
      continue;
    }
    console.log(`  Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    let buf = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        buf = await generateChunk(apiKey, voiceId, chunks[i]);
        break;
      } catch (e) {
        console.warn(`    Tentative ${attempt}/3: ${e.message}`);
        if (attempt < 3) await sleep(attempt * 3000);
        else throw e;
      }
    }
    writeFileSync(out, buf);
    console.log(`    OK ${(buf.length / 1024).toFixed(0)} KB`);
    if (i < chunks.length - 1) await sleep(1000);
  }

  // Concat avec ffmpeg
  console.log("\nConcatenation ffmpeg...");
  const concatFile = path.join(TMP_DIR, "concat.txt");
  writeFileSync(concatFile, chunkPaths.map(p => `file '${p}'`).join("\n"));
  // Re-encode for safe concat (different chunk metadata can break -c copy)
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -b:a 192k "${OUTPUT_PATH}"`, { stdio: "inherit" });

  const size = statSync(OUTPUT_PATH).size;
  console.log(`\n=== OK ===`);
  console.log(`MP3: ${OUTPUT_PATH} (${(size / 1024 / 1024).toFixed(2)} Mo)`);
}

main().catch(err => {
  console.error("ERREUR:", err);
  process.exit(1);
});
