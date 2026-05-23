// Silence capping: keep the natural rhythm, but cap any silence longer than --cap
// to a maximum duration. Short silences (< cap) pass through untouched, long ones
// get shortened in the middle so the breath on both sides of the cut is preserved.
//
// Usage:
//   node scripts/remove-silences-cap.mjs <input> [output] [--threshold=-40dB] [--cap=0.12] [--fade=0.01]
//
//   --threshold  noise floor for silence detection                  (default -40dB)
//   --cap        max silence duration allowed in output (seconds)   (default 0.12)
//   --fade       micro fade at each cut to avoid clicks (seconds)   (default 0.01)

import { spawnSync } from "child_process";
import { existsSync, statSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("usage: node scripts/remove-silences-cap.mjs <input> [output] [--threshold=-40dB] [--cap=0.12] [--fade=0.01]");
  process.exit(1);
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
const defaultOut = input.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `.capped${ext}`);
const output = positional[1] ?? defaultOut;

const threshold = flags.threshold ?? "-40dB";
const cap = parseFloat(flags.cap ?? "0.12");
const fade = parseFloat(flags.fade ?? "0.01");

// --- Detect silences with very low min so we see them all (cap decides what to keep) ---
const detect = spawnSync("ffmpeg", [
  "-hide_banner", "-nostats", "-i", input,
  "-af", `silencedetect=noise=${threshold}:d=0.01`,
  "-f", "null", "-",
]);
const log = detect.stderr.toString();

const startRe = /silence_start: ([\d.]+)/g;
const endRe = /silence_end: ([\d.]+)/g;
const starts = [...log.matchAll(startRe)].map((m) => parseFloat(m[1]));
const ends = [...log.matchAll(endRe)].map((m) => parseFloat(m[1]));

const probe = spawnSync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", input,
]);
const total = parseFloat(probe.stdout.toString().trim());

// --- Walk through silences, build a list of cut intervals ---
// Each silence longer than cap is shortened by removing (D - cap) from its middle.
// Short silences are kept as-is.
const cuts = []; // [{ from, to }] = intervals to REMOVE from the timeline
let longCount = 0, shortCount = 0, totalRemoved = 0;
for (let i = 0; i < starts.length; i++) {
  const s = starts[i];
  const e = ends[i];
  if (e === undefined || e === null) continue; // trailing silence, will handle below
  const dur = e - s;
  if (dur > cap) {
    const remove = dur - cap;
    // keep cap/2 on each side of the midpoint
    const cutFrom = s + cap / 2;
    const cutTo = e - cap / 2;
    cuts.push({ from: cutFrom, to: cutTo });
    longCount++;
    totalRemoved += remove;
  } else {
    shortCount++;
  }
}
// Trim trailing silence (no silence_end means file ends in silence)
const lastStart = starts[starts.length - 1];
const hasTrailingSilence = lastStart !== undefined && ends[ends.length - 1] === undefined;
if (hasTrailingSilence) {
  cuts.push({ from: lastStart + cap / 2, to: total });
  totalRemoved += (total - lastStart - cap / 2);
}

console.log(`input:      ${input} (${total.toFixed(2)}s)`);
console.log(`output:     ${output}`);
console.log(`silences:   ${starts.length} detected (>${0.01}s @ ${threshold})`);
console.log(`            ${shortCount} kept intact (<= ${cap}s)`);
console.log(`            ${longCount} capped to ${cap}s${hasTrailingSilence ? " + trailing tail trimmed" : ""}`);
console.log(`predicted:  -${totalRemoved.toFixed(2)}s -> ${(total - totalRemoved).toFixed(2)}s`);

if (cuts.length === 0) {
  console.log("nothing to cut — copying input to output");
  spawnSync("cp", [input, output]);
  process.exit(0);
}

// --- Build keep segments (complement of cuts) ---
const segments = [];
let prev = 0;
for (const c of cuts) {
  if (c.from > prev) segments.push({ start: prev, end: c.from });
  prev = c.to;
}
if (prev < total) segments.push({ start: prev, end: total });

// --- ffmpeg filter_complex with atrim + micro fade in/out + concat ---
const parts = segments.map((s, i) => {
  const dur = s.end - s.start;
  const f = Math.min(fade, dur / 4);
  const fadeOutStart = Math.max(0, dur - f);
  return `[0:a]atrim=start=${s.start.toFixed(4)}:end=${s.end.toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${f.toFixed(4)},afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${f.toFixed(4)}[s${i}]`;
});
const inputs = segments.map((_, i) => `[s${i}]`).join("");
const filter = parts.join(";") + `;${inputs}concat=n=${segments.length}:v=0:a=1[out]`;

const filterFile = path.join(os.tmpdir(), `silencecap-${Date.now()}.txt`);
writeFileSync(filterFile, filter);

// Detect input bitrate so we don't fall back to ffmpeg's 64kbps default.
// Voice at 64kbps mono mp3 sounds robotic — preserve source bitrate (typical 128-192kbps).
const probeIn = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "a:0",
  "-show_entries", "stream=bit_rate", "-of", "default=noprint_wrappers=1:nokey=1", input,
]);
const inBitrate = parseInt(probeIn.stdout.toString().trim(), 10);
const targetBitrate = Number.isFinite(inBitrate) && inBitrate >= 64000 ? Math.min(inBitrate, 256000) : 192000;
console.log(`output bitrate: ${(targetBitrate / 1000).toFixed(0)}k (source: ${Number.isFinite(inBitrate) ? (inBitrate / 1000).toFixed(0) + "k" : "unknown"})`);

const ff = spawnSync("ffmpeg", [
  "-y", "-hide_banner", "-nostats", "-i", input,
  "-filter_complex_script", filterFile,
  "-map", "[out]",
  "-c:a", "libmp3lame", "-b:a", `${Math.round(targetBitrate / 1000)}k`,
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

console.log(`\ndone: ${total.toFixed(2)}s -> ${durAfter.toFixed(2)}s  (-${(total - durAfter).toFixed(2)}s)`);
console.log(`size: ${(statSync(output).size / 1024 / 1024).toFixed(2)} MB`);
