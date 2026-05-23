#!/usr/bin/env node
// sticky-align-and-remontage.mjs
//
// 1. Run whisper-cli on the voiceover mp3
// 2. Match each image's narration ("Phrase du script") to the transcript words
//    sequentially, derive the actual duration per image from the audio.
// 3. Concat the images with their aligned durations and mux the voiceover.
//
// Usage:
//   PROJECT_SLUG=sticky_infantile_amnesia \
//   VOICEOVER=public/generated/sticky_infantile_amnesia/a2ef8d83-f1f2-46fd-a534-1cbebd65e705.mp3 \
//     node scripts/sticky-align-and-remontage.mjs
//
// Env:
//   WHISPER_BIN     default "whisper-cli"
//   WHISPER_MODEL   default ~/.cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin
//   LANG_HINT       default "en" (set "auto" to detect)
//   OUT_FILE        default "sticky_aligned.mp4" inside project dir

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROJECT_SLUG = process.env.PROJECT_SLUG || "sticky_infantile_amnesia";
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_SLUG);
const IMG_DIR = path.join(OUT_DIR, "images");
const PROMPTS_JSON = path.join(OUT_DIR, "prompts.json");

const VOICEOVER = process.env.VOICEOVER
  ? (path.isAbsolute(process.env.VOICEOVER) ? process.env.VOICEOVER : path.join(ROOT, process.env.VOICEOVER))
  : null;
const OUT_FILE = process.env.OUT_FILE || "sticky_aligned.mp4";
const OUT_PATH = path.join(OUT_DIR, OUT_FILE);

const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL
  || path.join(os.homedir(), ".cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin");
const LANG_HINT = process.env.LANG_HINT || "en";

const MIN_DUR = parseFloat(process.env.MIN_DUR || "1.0");
const MAX_DUR = parseFloat(process.env.MAX_DUR || "30");

function run(bin, args, { inheritStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", inheritStderr ? "inherit" : "pipe", inheritStderr ? "inherit" : "pipe"] });
    let stdout = "", stderr = "";
    if (!inheritStderr) {
      child.stdout?.on("data", (b) => { stdout += b.toString(); });
      child.stderr?.on("data", (b) => { stderr += b.toString(); });
    }
    child.on("error", (e) => reject(e));
    child.on("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${bin} exit ${code}: ${(stderr || "").slice(-400)}`)));
  });
}

async function transcribe(audioPath) {
  const outBase = audioPath.replace(/\.[^.]+$/, "") + ".whisper";
  const jsonPath = `${outBase}.json`;
  if (existsSync(jsonPath) && !process.env.WHISPER_FORCE) {
    console.log(`Whisper: re-use ${path.relative(ROOT, jsonPath)} (set WHISPER_FORCE=1 to retranscribe)`);
  } else {
    console.log(`Whisper: transcribing ${path.relative(ROOT, audioPath)}...`);
    const t0 = Date.now();
    await run(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      "-l", LANG_HINT,
      "-oj",
      "-of", outBase,
      "-sow",
      audioPath,
    ], { inheritStderr: true });
    console.log(`Whisper: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const segs = [];
  for (const seg of raw.transcription || []) {
    if (!seg.offsets) continue;
    segs.push({ start: seg.offsets.from / 1000, end: seg.offsets.to / 1000, text: (seg.text || "").trim() });
  }
  if (!segs.length) throw new Error("Whisper: aucun segment");
  console.log(`Whisper: ${segs.length} segments, total audio ~${segs[segs.length - 1].end.toFixed(1)}s`);
  return segs;
}

function normalize(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(s) { return normalize(s).split(" ").filter(Boolean); }

function expandToWords(segments) {
  const out = [];
  for (const seg of segments) {
    const w = tokens(seg.text);
    if (!w.length) continue;
    const span = Math.max(0.01, seg.end - seg.start);
    const per = span / w.length;
    for (let i = 0; i < w.length; i++) {
      out.push({ word: w[i], start: seg.start + i * per, end: seg.start + (i + 1) * per });
    }
  }
  return out;
}

function alignScenes(scenes, words) {
  const total = words[words.length - 1].end;
  let cursor = 0;
  let matchedTotal = 0, scriptTotal = 0;
  const aligned = [];

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const w = tokens(sc.narration);
    scriptTotal += w.length;
    const sceneStart = words[Math.min(cursor, words.length - 1)].start;
    let j = cursor;
    let matched = 0;
    for (let k = 0; k < w.length && j < words.length; k++) {
      let look = 0;
      while (j < words.length && words[j].word !== w[k] && look < 5) { j++; look++; }
      if (j < words.length && words[j].word === w[k]) { matched++; j++; }
    }
    matchedTotal += matched;
    const endIdx = Math.min(j, words.length) - 1;
    const sceneEnd = endIdx >= 0 ? words[Math.max(endIdx, 0)].end : sceneStart;
    cursor = Math.min(j, words.length);
    let dur = Math.max(MIN_DUR, Math.min(MAX_DUR, sceneEnd - sceneStart));
    aligned.push({ ...sc, durationSeconds: Number(dur.toFixed(2)), _start: sceneStart, _end: sceneEnd });
  }

  // Last scene: extend to the end of audio if it falls short.
  if (aligned.length > 0) {
    const last = aligned[aligned.length - 1];
    const tail = total - last._start;
    if (tail > last.durationSeconds) {
      last.durationSeconds = Math.max(MIN_DUR, Math.min(MAX_DUR, Number(tail.toFixed(2))));
    }
  }

  return { aligned, total, matchedRatio: scriptTotal ? matchedTotal / scriptTotal : 0 };
}

function listImageByRow() {
  const m = new Map();
  for (const f of readdirSync(IMG_DIR)) {
    const r = f.match(/^(\d+)_/);
    if (r) m.set(parseInt(r[1], 10), path.join(IMG_DIR, f));
  }
  return m;
}

async function buildAlignedMontage(scenes) {
  const imgs = listImageByRow();
  const ordered = scenes
    .map((s) => ({ ...s, imagePath: imgs.get(s.n) }))
    .filter((s) => s.imagePath);
  if (!ordered.length) throw new Error("Aucune image trouvée pour le montage");

  const lines = [];
  for (const s of ordered) {
    lines.push(`file '${s.imagePath.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${s.durationSeconds}`);
  }
  lines.push(`file '${ordered[ordered.length - 1].imagePath.replace(/'/g, "'\\''")}'`);
  const listPath = path.join(OUT_DIR, "concat-aligned.txt");
  writeFileSync(listPath, lines.join("\n"));

  const total = ordered.reduce((a, b) => a + b.durationSeconds, 0);
  console.log(`Montage: ${ordered.length} images, ${total.toFixed(1)}s -> ${path.relative(ROOT, OUT_PATH)}`);

  const args = [
    "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-i", VOICEOVER,
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p,fps=30",
    "-fps_mode", "vfr",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    OUT_PATH,
  ];
  await run("ffmpeg", args, { inheritStderr: true });
}

async function main() {
  if (!VOICEOVER || !existsSync(VOICEOVER)) {
    throw new Error(`VOICEOVER introuvable: ${VOICEOVER}`);
  }
  if (!existsSync(PROMPTS_JSON)) throw new Error(`prompts.json absent: ${PROMPTS_JSON}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const scenes = JSON.parse(readFileSync(PROMPTS_JSON, "utf-8"));
  console.log(`Project: ${PROJECT_SLUG} — ${scenes.length} scènes, voiceover=${path.basename(VOICEOVER)}`);

  const segs = await transcribe(VOICEOVER);
  const words = expandToWords(segs);
  if (!words.length) throw new Error("Pas de mots après expansion");

  const { aligned, total, matchedRatio } = alignScenes(scenes, words);
  console.log(`Aligned: audio=${total.toFixed(1)}s, match=${(matchedRatio * 100).toFixed(1)}% des mots du script`);

  // Sanity report
  const tooShort = aligned.filter((s) => s.durationSeconds <= MIN_DUR + 0.01).length;
  if (tooShort) console.log(`Warn: ${tooShort} scenes saturées à MIN_DUR=${MIN_DUR}s — alignement peut être bruité sur celles-ci`);

  // Persist the aligned plan for traceability.
  writeFileSync(path.join(OUT_DIR, "scenes_aligned.json"),
    JSON.stringify({ totalAudioSec: total, matchedRatio, scenes: aligned }, null, 2));

  await buildAlignedMontage(aligned);
  console.log(`OK: ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
