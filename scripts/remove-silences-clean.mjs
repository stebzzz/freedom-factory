// Clean silence removal: 2-pass via silencedetect + atrim/afade/concat.
// silenceremove cuts hard at the threshold crossing → audible clicks at every join.
// Here: detect silences, keep a small breath padding around each speech segment,
// micro-fade (20ms) in/out at every cut → no clicks, natural rhythm.
//
// Usage:
//   node scripts/remove-silences-clean.mjs <input> [output] [--threshold=-35dB] [--min=0.4] [--pad=0.08] [--fade=0.02]
//
//   --threshold  noise floor for silence detection                     (default -35dB)
//   --min        min silence duration to remove in seconds             (default 0.4)
//   --pad        breath kept around each speech segment in seconds     (default 0.08)
//   --fade       micro fade-in/out at each cut in seconds              (default 0.02)

import { spawnSync } from "child_process";
import { existsSync, statSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.log("usage: node scripts/remove-silences-clean.mjs <input> [output] [--threshold=-35dB] [--min=0.4] [--pad=0.08] [--fade=0.02]");
  process.exit(args.length === 0 ? 1 : 0);
}

const positional = args.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const input = positional[0];
if (!existsSync(input)) { console.error(`input not found: ${input}`); process.exit(1); }

const ext = path.extname(input);
const defaultOut = input.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `.clean${ext}`);
const output = positional[1] ?? defaultOut;

const threshold = flags.threshold ?? "-35dB";
const minSilence = parseFloat(flags.min ?? "0.4");
const pad = parseFloat(flags.pad ?? "0.08");
const fade = parseFloat(flags.fade ?? "0.02");

// --- Pass 1: detect silences ---
const detect = spawnSync("ffmpeg", [
  "-hide_banner", "-nostats", "-i", input,
  "-af", `silencedetect=noise=${threshold}:d=${minSilence}`,
  "-f", "null", "-",
]);
const log = detect.stderr.toString();

const silences = [];
const startRe = /silence_start: ([\d.]+)/g;
const endRe = /silence_end: ([\d.]+)/g;
const starts = [...log.matchAll(startRe)].map((m) => parseFloat(m[1]));
const ends = [...log.matchAll(endRe)].map((m) => parseFloat(m[1]));
for (let i = 0; i < starts.length; i++) silences.push({ start: starts[i], end: ends[i] ?? null });

// --- Total duration ---
const probe = spawnSync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", input,
]);
const total = parseFloat(probe.stdout.toString().trim());

// --- Build speech segments (inverse of silences), with breath pad ---
// trailing silence without silence_end means the file ends in silence — drop it.
const segments = [];
let cursor = 0;
for (const s of silences) {
  if (s.end === null) continue;
  const segStart = Math.max(0, cursor - pad);
  const segEnd = Math.min(total, s.start + pad);
  if (segEnd > segStart + 0.05) segments.push({ start: segStart, end: segEnd });
  cursor = s.end;
}
// tail after last silence
if (cursor < total) {
  const segStart = Math.max(0, cursor - pad);
  if (total > segStart + 0.05) segments.push({ start: segStart, end: total });
}

if (segments.length === 0) {
  console.error("no speech segments detected — check --threshold/--min");
  process.exit(1);
}

console.log(`input:      ${input} (${total.toFixed(2)}s)`);
console.log(`output:     ${output}`);
console.log(`silences:   ${silences.length} detected (>${minSilence}s @ ${threshold})`);
console.log(`segments:   ${segments.length} speech chunks`);
console.log(`params:     pad=${pad}s fade=${fade}s`);

// --- Build filter_complex with atrim + afade per segment + concat ---
// Each segment: atrim → asetpts reset → afade in/out (relative to the trimmed segment).
const parts = segments.map((s, i) => {
  const dur = s.end - s.start;
  const fadeOutStart = Math.max(0, dur - fade);
  return `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade}[s${i}]`;
});
const inputs = segments.map((_, i) => `[s${i}]`).join("");
const filter = parts.join(";") + `;${inputs}concat=n=${segments.length}:v=0:a=1[out]`;

// filter_complex can blow CLI length on very long files — write to a temp file.
const filterFile = path.join(os.tmpdir(), `silenceclean-${Date.now()}.txt`);
writeFileSync(filterFile, filter);

// Preserve source bitrate — ffmpeg's mp3 default (~128k) sounds robotic on voice.
const probeIn = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "a:0",
  "-show_entries", "stream=bit_rate", "-of", "default=noprint_wrappers=1:nokey=1", input,
]);
const inBitrate = parseInt(probeIn.stdout.toString().trim(), 10);
const targetBitrate = Number.isFinite(inBitrate) && inBitrate >= 64000 ? Math.min(inBitrate, 256000) : 192000;
const isMp3 = path.extname(output).toLowerCase() === ".mp3";
console.log(`output bitrate: ${(targetBitrate / 1000).toFixed(0)}k (source: ${Number.isFinite(inBitrate) ? (inBitrate / 1000).toFixed(0) + "k" : "unknown"})`);

const encodeArgs = isMp3
  ? ["-c:a", "libmp3lame", "-b:a", `${Math.round(targetBitrate / 1000)}k`]
  : ["-b:a", `${Math.round(targetBitrate / 1000)}k`];

const ff = spawnSync("ffmpeg", [
  "-y", "-hide_banner", "-nostats", "-i", input,
  "-filter_complex_script", filterFile,
  "-map", "[out]",
  ...encodeArgs,
  output,
], { stdio: ["ignore", "inherit", "inherit"] });

try { unlinkSync(filterFile); } catch {}

if (ff.status !== 0) {
  console.error(`ffmpeg failed with code ${ff.status}`);
  process.exit(ff.status ?? 1);
}

const probeAfter = spawnSync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", output,
]);
const durAfter = parseFloat(probeAfter.stdout.toString().trim());
const saved = total - durAfter;
const pct = (saved / total) * 100;

console.log(`\ndone: ${total.toFixed(2)}s -> ${durAfter.toFixed(2)}s  (-${saved.toFixed(2)}s, ${pct.toFixed(1)}% trimmed)`);
console.log(`size: ${(statSync(output).size / 1024 / 1024).toFixed(2)} MB`);
