#!/usr/bin/env node
// Concat: whisper word-level → anchor first-word with next-3 scoring + drift guard → ffmpeg.
// Usage: node concat.mjs <jobName>

import fs from "fs/promises";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";

const ROOT = "/Users/stephanezayat/Documents/youtube-freedom-factory";
const WHISPER_BIN = "whisper-cli";
const WHISPER_MODEL = `${os.homedir()}/.cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin`;
// MIN_SLICE: minimum duration an image stays on screen. Lower = better sync (no drift) but
// short flashes possible. CLI override: --min=0.3
const minArg = process.argv.find(a => a.startsWith("--min="));
const MIN_SLICE = minArg ? parseFloat(minArg.replace("--min=", "")) : 0.4;

const jobName = process.argv[2];
if (!jobName) { console.error("usage: <jobName>"); process.exit(1); }
const jobDir = `${ROOT}/public/generated/${jobName}`;
if (!existsSync(jobDir)) { console.error("jobDir not found"); process.exit(1); }
const audioPath = `${jobDir}/voiceover.mp3`;
if (!existsSync(audioPath)) { console.error("voiceover.mp3 not found"); process.exit(1); }

const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", audioPath]);
const audioDur = parseFloat(dur.stdout.toString().trim());
console.log(`[concat] ${jobName} | audio: ${audioDur.toFixed(2)}s`);

const wordsJson = `${jobDir}/voiceover.words.json`;
if (!existsSync(wordsJson)) {
  console.log("[concat] whisper word-level...");
  const t0 = Date.now();
  const r = spawnSync(WHISPER_BIN, [
    "-m", WHISPER_MODEL, "-l", "en", "-oj", "-of", `${jobDir}/voiceover.words`,
    "-sow", "-ml", "1", audioPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) { console.error("whisper failed:", r.stderr.toString().slice(-400)); process.exit(1); }
  console.log(`[concat] whisper ✓ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const whisper = JSON.parse(await fs.readFile(wordsJson, "utf-8"));
const script = JSON.parse(await fs.readFile(`${jobDir}/script.json`, "utf-8"));

const stem = (w) => w.replace(/(ing|ed|s|d)$/, "");
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s'’]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).split(" ").filter(Boolean);
const eq = (a, b) => a === b || stem(a) === stem(b);

const timed = [];
for (const seg of whisper.transcription) {
  const parts = toks(seg.text);
  if (parts.length === 0) continue;
  const s = seg.offsets.from / 1000; const e = seg.offsets.to / 1000;
  const slice = (e - s) / parts.length;
  parts.forEach((w, i) => timed.push({ word: w, start: s + i * slice, end: s + (i + 1) * slice }));
}
console.log(`[concat] whisper tokens: ${timed.length} | scenes: ${script.scenes.length}`);

// Anchor first-word with next-3 scoring + drift guard.
// If we detect a big gap relative to the expected words/sec rate, we re-anchor.
const LOOKAHEAD = 25;
const MAX_CANDIDATES = 5;
let cursor = 0;
const sceneStarts = [];
let anchored = 0;
const misses = [];
for (let i = 0; i < script.scenes.length; i++) {
  const sw = toks(script.scenes[i].narration);
  let bestFound = -1; let bestScore = 0;
  for (let candidate = 0; candidate < Math.min(MAX_CANDIDATES, sw.length); candidate++) {
    const target = sw[candidate];
    for (let j = cursor; j < Math.min(cursor + LOOKAHEAD + candidate, timed.length); j++) {
      if (eq(timed[j].word, target)) {
        let score = 1;
        for (let k = 1; k <= 3 && k + candidate < sw.length && j + k < timed.length; k++) {
          if (eq(timed[j + k].word, sw[k + candidate])) score++;
        }
        if (score > bestScore) { bestScore = score; bestFound = j - candidate; }
        if (score >= 3) break;
      }
    }
    if (bestScore >= 3) break;
  }
  if (bestFound >= 0 && bestFound < timed.length) {
    sceneStarts.push(timed[bestFound].start);
    cursor = bestFound + sw.length; anchored++;
  } else {
    misses.push(i);
    sceneStarts.push(cursor < timed.length ? timed[cursor].start : audioDur);
  }
}
console.log(`[concat] anchored ${anchored}/${script.scenes.length} (${(anchored / script.scenes.length * 100).toFixed(1)}%) | misses: ${misses.length}${misses.length>0?` → ${misses.slice(0,10).join(",")}`:""}`);

// Drift-free MIN_SLICE enforcement: when a scene is shorter than MIN_SLICE, try to "absorb"
// the deficit by SHRINKING the next scene if it has buffer (instead of pushing it later).
// This keeps sceneStart[i+1] at its anchored Whisper position whenever possible.
const PUSH_LIMIT = 0.4; // we accept at most 0.4s of forward push before giving up
for (let i = 0; i < sceneStarts.length - 1; i++) {
  const gap = sceneStarts[i + 1] - sceneStarts[i];
  if (gap >= MIN_SLICE) continue;
  const deficit = MIN_SLICE - gap; // how much more we need
  const nextNext = i + 2 < sceneStarts.length ? sceneStarts[i + 2] : audioDur;
  const nextGap = nextNext - sceneStarts[i + 1];
  // If next scene has enough buffer above MIN_SLICE, absorb the deficit there (no push to scene i+2)
  if (nextGap >= MIN_SLICE + deficit) {
    // Keep sceneStarts[i+1] anchored — the next scene just becomes a tiny bit shorter
    // But we need scene i to be MIN_SLICE long → push i+1 only if scene i hasn't itself been pushed
    sceneStarts[i + 1] = sceneStarts[i] + MIN_SLICE;
  } else {
    // No buffer — accept a small push, capped at PUSH_LIMIT
    const push = Math.min(deficit, PUSH_LIMIT);
    sceneStarts[i + 1] = sceneStarts[i] + Math.max(MIN_SLICE, gap + push);
  }
}
// Final pass: ensure monotonicity + last scene fits in audioDur
for (let i = 1; i < sceneStarts.length; i++) {
  if (sceneStarts[i] < sceneStarts[i - 1]) sceneStarts[i] = sceneStarts[i - 1] + 0.1;
  if (sceneStarts[i] > audioDur - 0.1) sceneStarts[i] = audioDur - 0.1;
}

const imagesDir = `${jobDir}/images`;
const lines = []; let lastValid = null; let missingImgs = 0;
for (let i = 0; i < script.scenes.length; i++) {
  const idx = script.scenes[i].index;
  let imgPath = `${imagesDir}/scene_${String(idx).padStart(3, "0")}.png`;
  if (!existsSync(imgPath)) {
    missingImgs++;
    if (lastValid) imgPath = lastValid; else continue;
  } else lastValid = imgPath;
  const nextStart = i + 1 < sceneStarts.length ? sceneStarts[i + 1] : audioDur;
  const d = Math.max(MIN_SLICE, nextStart - sceneStarts[i]);
  lines.push(`file '${imgPath}'`); lines.push(`duration ${d.toFixed(3)}`);
}
lines.push(lines[lines.length - 2]);
await fs.writeFile(`${jobDir}/concat.txt`, lines.join("\n"));
console.log(`[concat] concat.txt | missing imgs duplicated: ${missingImgs}`);

const outPath = `${jobDir}/output.mp4`;
const t0 = Date.now();
const ff = spawnSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "concat", "-safe", "0", "-i", `${jobDir}/concat.txt`,
  "-i", audioPath,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
  "-vf", "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black",
  "-c:a", "aac", "-b:a", "192k", "-shortest", outPath,
], { stdio: ["ignore", "inherit", "inherit"] });
if (ff.status !== 0) { console.error("ffmpeg failed"); process.exit(1); }
const sz = (await fs.stat(outPath)).size / 1024 / 1024;
console.log(`[concat] ✓ ${outPath} | ${sz.toFixed(1)} MB | ffmpeg ${((Date.now() - t0) / 1000).toFixed(1)}s`);
