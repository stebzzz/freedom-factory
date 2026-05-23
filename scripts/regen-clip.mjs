#!/usr/bin/env node
/**
 * regen-clip.mjs — regenere un clip Kling precis avec un motion prompt custom.
 *
 * Usage : node scripts/regen-clip.mjs <sceneIndex> --prompt="..."
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateI2VClipWithRetry } from "./lib-wan-image.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Support JOB_DIR env var pour cibler le bon projet (job_caesar_full, job_concubine, etc).
// Fallback : job_caesar_full pour retro-compat — mais FORCEMENT dans public/generated/.
const JOB_DIR = process.env.JOB_DIR
  ? (path.isAbsolute(process.env.JOB_DIR) ? process.env.JOB_DIR : path.join(ROOT, "public/generated", process.env.JOB_DIR))
  : path.join(ROOT, "public/generated/job_caesar_full");
const CONFIG_PATH = path.join(ROOT, "config/settings.json");

const sceneIdx = parseInt(process.argv[2] ?? "0", 10);
const promptArg = process.argv.find((a) => a.startsWith("--prompt="));
if (!promptArg) { console.error("Missing --prompt=\"...\""); process.exit(1); }
const motionPrompt = promptArg.slice("--prompt=".length);

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const script = JSON.parse(readFileSync(path.join(JOB_DIR, "script.json"), "utf-8")).scenes;
const scene = script[sceneIdx];
if (!scene) { console.error(`scene ${sceneIdx} missing`); process.exit(1); }

const imgPath = path.join(JOB_DIR, "images", `scene_${String(sceneIdx).padStart(3, "0")}_c0.png`);
if (!existsSync(imgPath)) { console.error(`image missing: ${imgPath}`); process.exit(1); }

// Meme nommage que la pipeline (clip_{idx}_{ci}_{dur}s.mp4)
const durSec = scene.durationSeconds;
const clipPath = path.join(JOB_DIR, "clips", `clip_${String(sceneIdx).padStart(3, "0")}_0_${durSec}s.mp4`);

console.log(`Regen clip scene ${sceneIdx} (${durSec}s)`);
console.log(`  narr:   ${scene.narration}`);
console.log(`  motion: ${motionPrompt.slice(0, 160)}${motionPrompt.length > 160 ? "..." : ""}`);

const r = await generateI2VClipWithRetry({
  config,
  imagePath: imgPath,
  motionPrompt,
  outputPath: clipPath,
  durationSec: durSec,
  clipLabel: `regen_s${sceneIdx}`,
});

console.log(`OK → ${r.clipPath}`);
console.log(`\nAprès regen, relance le montage: node scripts/run-medieval-job.mjs scripts/script-medieval.txt --yes`);
