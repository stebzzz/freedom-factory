#!/usr/bin/env node
// concat-flow.mjs
// Assemble images + voiceover en MP4 en utilisant le timing whisper_trigger_text.
//
// Usage:
//   node scripts/concat-flow.mjs \
//     --config concat-flow.json \
//     --images /Users/stephanezayat/Downloads/turboflow \
//     --voice  dd6744ce-39d8-4516-bdc1-1fd1e3711096.mp3 \
//     [--out outputs/foo.mp4] [--force]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? def : args[i + 1];
};
const FORCE = args.includes("--force");

const CONFIG_PATH = path.resolve(ROOT, arg("config", "concat-flow.json"));
const IMAGES_DIR = path.resolve(arg("images", ""));
const VOICE_PATH = path.resolve(arg("voice", ""));
if (!existsSync(CONFIG_PATH)) throw new Error(`Config introuvable: ${CONFIG_PATH}`);
if (!existsSync(IMAGES_DIR)) throw new Error(`Dossier images introuvable: ${IMAGES_DIR}`);
if (!existsSync(VOICE_PATH)) throw new Error(`Voiceover introuvable: ${VOICE_PATH}`);

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const OUT = path.resolve(ROOT, arg("out", cfg.project.outputPath));
const WORK_DIR = path.join(ROOT, ".concat-work", cfg.project.name);
mkdirSync(path.dirname(OUT), { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH
  || path.join(os.homedir(), ".cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin");

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: opts.silent ? ["ignore", "ignore", "pipe"] : "inherit" });
    let err = "";
    if (opts.silent) p.stderr?.on("data", (c) => { err += c.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}\n${err.slice(-1000)}`)));
  });
}

function runCapture(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => { out += c.toString(); });
    p.stderr.on("data", (c) => { err += c.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}\n${err}`)));
  });
}

function normalize(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    // Collapse periods between letters so abbreviations match: "a.m." → "am",
    // "U.S." → "us". Without this, whisper "a.m." tokenizes as ["a","m"] and
    // never matches the script's "AM".
    .replace(/\b([a-z])\.([a-z])\.?/gi, "$1$2")
    .replace(/[^a-z0-9$%' ]/gi, " ")
    .replace(/\s+/g, " ").trim();
}
const tokens = (s) => normalize(s).split(" ").filter(Boolean);

// 1. Probe audio duration
const probe = await runCapture("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", VOICE_PATH,
]);
const audioDur = parseFloat(probe.trim());
console.log(`Audio: ${audioDur.toFixed(2)}s`);

// 2. Run whisper (cached)
const whisperBase = path.join(WORK_DIR, "voice.whisper");
const whisperJson = whisperBase + ".json";
if (!existsSync(whisperJson) || FORCE) {
  const wav = path.join(WORK_DIR, "voice.wav");
  if (!existsSync(wav) || FORCE) {
    console.log("→ MP3 → WAV 16kHz mono");
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-i", VOICE_PATH, "-ar", "16000", "-ac", "1", wav], { silent: true });
  }
  console.log("→ whisper-cli (transcription mots-à-mots)");
  await run("whisper-cli", [
    "-m", WHISPER_MODEL,
    "-l", "en",
    "-oj", "-sow",
    "-of", whisperBase,
    wav,
  ], { silent: true });
}

const whisperRaw = JSON.parse(readFileSync(whisperJson, "utf-8"));
const segments = (whisperRaw.transcription || []).map((s) => ({
  start: (s.offsets?.from ?? 0) / 1000,
  end: (s.offsets?.to ?? 0) / 1000,
  text: (s.text || "").trim(),
}));
if (!segments.length) throw new Error("Whisper a renvoyé 0 segment");

// Expand to estimated word timing (interpolate dans chaque segment)
const words = [];
for (const seg of segments) {
  const segTokens = tokens(seg.text);
  if (!segTokens.length) continue;
  const span = Math.max(0.01, seg.end - seg.start);
  const per = span / segTokens.length;
  for (let i = 0; i < segTokens.length; i++) {
    words.push({
      word: segTokens[i],
      start: seg.start + i * per,
      end: seg.start + (i + 1) * per,
    });
  }
}
console.log(`Mots horodatés: ${words.length}`);

// 3. Fuzzy match each triggerText to find start time
const perImage = cfg.timing.perImage;
const starts = new Array(perImage.length).fill(null);
let cursor = 0;
let matched = 0;

for (let idx = 0; idx < perImage.length; idx++) {
  const trig = tokens(perImage[idx].triggerText);
  if (!trig.length) continue;
  const LOOKAHEAD = 8;
  const SEARCH_WINDOW = Math.min(words.length, cursor + 500);
  let bestStart = -1, bestScore = 0, bestEndIdx = cursor;
  // Distance penalty: prefer earlier matches. Without this, an ambiguous short
  // trigger ("drilled holes") can match perfectly far ahead in the audio
  // ("the drilled holes proved...") and yank cursor past everything in between.
  const DIST_PENALTY = 0.003;
  for (let i = cursor; i < SEARCH_WINDOW; i++) {
    let j = i, hits = 0;
    for (const t of trig) {
      // Tolerant scan: if the token isn't found within LOOKAHEAD, count a miss
      // but DON'T advance j — otherwise one numeric divergence ("three hundred"
      // vs "300") burns the whole trigger and cursor drifts.
      let probe = j, look = 0;
      while (probe < words.length && words[probe].word !== t && look < LOOKAHEAD) { probe++; look++; }
      if (probe < words.length && words[probe].word === t) { hits++; j = probe + 1; }
    }
    const score = hits / trig.length;
    const effective = score - (i - cursor) * DIST_PENALTY;
    if (effective > bestScore) {
      bestScore = effective; bestStart = i; bestEndIdx = j;
      if (score === 1 && (i - cursor) < 30) break;
    }
  }
  if (bestStart >= 0 && bestScore >= 0.35) {
    starts[idx] = words[bestStart].start;
    cursor = bestEndIdx;
    matched++;
  }
}
console.log(`Triggers matchés: ${matched}/${perImage.length}`);

// 4. Interpolate missing starts
if (starts[0] == null) starts[0] = 0;
for (let i = 1; i < starts.length; i++) {
  if (starts[i] == null) {
    let j = i + 1;
    while (j < starts.length && starts[j] == null) j++;
    const endVal = j < starts.length ? starts[j] : audioDur;
    const startVal = starts[i - 1];
    const gap = j - (i - 1);
    for (let k = i; k < j; k++) {
      starts[k] = startVal + ((endVal - startVal) * (k - (i - 1))) / gap;
    }
    i = j - 1;
  }
}
// Enforce monotonic increasing (whisper can mis-match, causing back-jumps)
for (let i = 1; i < starts.length; i++) {
  if (starts[i] <= starts[i - 1]) starts[i] = starts[i - 1] + 0.01;
}

// 5. Compute clamped durations
const MIN = cfg.timing.minImageDurationSec || 0.5;
const MAX = cfg.timing.maxImageDurationSec || 4;
const durations = starts.map((s, i) => {
  const next = i + 1 < starts.length ? starts[i + 1] : audioDur;
  return Math.max(MIN, Math.min(MAX, next - s));
});

let totalVid = durations.reduce((a, b) => a + b, 0);
console.log(`Durée vidéo (clamp ${MIN}-${MAX}s): ${totalVid.toFixed(2)}s vs audio ${audioDur.toFixed(2)}s`);

// Mise à l'échelle proportionnelle pour matcher exactement la durée audio.
// On respecte le min (mais on relâche le max si nécessaire pour couvrir l'audio).
if (Math.abs(totalVid - audioDur) > 0.1) {
  const scale = audioDur / totalVid;
  for (let i = 0; i < durations.length; i++) {
    durations[i] = Math.max(MIN, durations[i] * scale);
  }
  // Réajustement final pour tomber juste
  const adjusted = durations.reduce((a, b) => a + b, 0);
  durations[durations.length - 1] += audioDur - adjusted;
  totalVid = durations.reduce((a, b) => a + b, 0);
  console.log(`→ Échelle ×${scale.toFixed(3)} → ${totalVid.toFixed(2)}s`);
}

// 6. Write concat list (concat demuxer accepts still images with duration lines)
const concatList = path.join(WORK_DIR, "concat.txt");
let listContent = "";
const list = cfg.images.list;
for (let i = 0; i < list.length; i++) {
  const imgPath = path.join(IMAGES_DIR, list[i]);
  if (!existsSync(imgPath)) throw new Error(`Image manquante: ${imgPath}`);
  listContent += `file '${imgPath.replace(/'/g, "'\\''")}'\nduration ${durations[i].toFixed(3)}\n`;
}
// Last image repeated (concat demuxer quirk for still images)
const lastPath = path.join(IMAGES_DIR, list[list.length - 1]);
listContent += `file '${lastPath.replace(/'/g, "'\\''")}'\n`;
writeFileSync(concatList, listContent);

// 7. Final encode
const W = cfg.video.width, H = cfg.video.height, FPS = cfg.video.fps;
const vfilter = [
  `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
  `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
  `setsar=1`,
  `fps=${FPS}`,
  `format=yuv420p`,
].join(",");

console.log(`→ Encodage final → ${OUT}`);
await run("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "warning", "-stats",
  "-f", "concat", "-safe", "0", "-i", concatList,
  "-i", VOICE_PATH,
  "-vf", vfilter,
  "-c:v", cfg.encoder.codec || "libx264",
  "-preset", cfg.encoder.preset || "medium",
  "-crf", String(cfg.encoder.crf ?? 20),
  "-c:a", "aac", "-b:a", "192k",
  "-map", "0:v:0", "-map", "1:a:0",
  "-shortest",
  "-movflags", "+faststart",
  OUT,
]);

// Timing report
const report = {
  audioDuration: audioDur,
  matchedTriggers: matched,
  totalTriggers: perImage.length,
  totalVideoDuration: totalVid,
  images: list.map((img, i) => ({
    image: img,
    triggerText: perImage[i].triggerText,
    start: Number(starts[i].toFixed(3)),
    duration: Number(durations[i].toFixed(3)),
  })),
};
const reportPath = path.join(WORK_DIR, "timing-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`✓ Done: ${OUT}`);
console.log(`  Timing report: ${reportPath}`);
