// Remove silences from an audio (or video) file via FFmpeg silenceremove filter.
//
// Usage:
//   node scripts/remove-silences.mjs <input> [output] [--threshold=-30dB] [--min=0.5] [--keep=0.1]
//
//   --threshold  dB level below which audio is considered silence  (default -30dB)
//   --min        min silence duration in seconds to be removed     (default 0.5)
//   --keep       padding kept around speech in seconds             (default 0.1)
//
// Examples:
//   node scripts/remove-silences.mjs voice.mp3
//     -> voice.nosilence.mp3
//   node scripts/remove-silences.mjs voice.mp3 tight.mp3 --threshold=-35dB --min=0.3

import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import path from "path";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/remove-silences.mjs <input> [output] [--threshold=-30dB] [--min=0.5] [--keep=0.1]");
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
if (!existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(1);
}

const ext = path.extname(input);
const defaultOut = input.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `.nosilence${ext}`);
const output = positional[1] ?? defaultOut;

const threshold = flags.threshold ?? "-30dB";
const minSilence = parseFloat(flags.min ?? "0.5");
const keep = parseFloat(flags.keep ?? "0.1");

// silenceremove with stop_periods=-1 trims every silent run in the file (not just leading/trailing).
// stop_duration = how long silence must last to be cut. stop_silence = padding to keep around speech.
const filter =
  `silenceremove=stop_periods=-1` +
  `:stop_duration=${minSilence}` +
  `:stop_threshold=${threshold}` +
  `:stop_silence=${keep}`;

const probeBefore = spawnSync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", input,
]);
const durBefore = parseFloat(probeBefore.stdout.toString().trim());

console.log(`input:     ${input} (${durBefore.toFixed(2)}s)`);
console.log(`output:    ${output}`);
console.log(`filter:    ${filter}`);

const ff = spawnSync("ffmpeg", [
  "-y", "-i", input,
  "-af", filter,
  output,
], { stdio: ["ignore", "inherit", "inherit"] });

if (ff.status !== 0) {
  console.error(`ffmpeg failed with code ${ff.status}`);
  process.exit(ff.status ?? 1);
}

const probeAfter = spawnSync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", output,
]);
const durAfter = parseFloat(probeAfter.stdout.toString().trim());
const saved = durBefore - durAfter;
const pct = (saved / durBefore) * 100;

console.log(`\ndone: ${durBefore.toFixed(2)}s -> ${durAfter.toFixed(2)}s  (-${saved.toFixed(2)}s, ${pct.toFixed(1)}% trimmed)`);
console.log(`size: ${(statSync(output).size / 1024 / 1024).toFixed(2)} MB`);
