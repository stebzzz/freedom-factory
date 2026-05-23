#!/usr/bin/env node
// build-galveston-montage.mjs
// Consomme montage-plan.json + clips Veo3 + voiceover MP3,
// produit un mp4 final synchronisé.
//
// Stratégie par scène :
//   trim   → cut à voice_dur avec léger fade out
//   keep   → re-encode tel quel
//   slow   → setpts=factor*PTS (factor ≤ 1.4)
//   extend → setpts=1.4*PTS puis tpad clone de la dernière frame jusqu'à voice_dur
//
// Encodeur : h264_videotoolbox (HW Apple Silicon) si dispo, sinon libx264.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROJECT_DIR = path.join(ROOT, "public/generated/galveston_1900_veo3");
const PLAN_PATH = path.join(PROJECT_DIR, "montage-plan.json");
const SEG_DIR = path.join(PROJECT_DIR, "segments");
const CONCAT_LIST = path.join(PROJECT_DIR, "concat.txt");
const FINAL_OUT = path.join(PROJECT_DIR, "montage.mp4");
const VOICEOVER = path.join(PROJECT_DIR, "voiceover/galveston-doc.mp3");

const TARGET_W = 1280;
const TARGET_H = 720;
const TARGET_FPS = 24;
const MAX_SLOW = 1.4;
const FADE_OUT_S = 0.25;
const ENCODER = process.env.ENCODER || "h264_videotoolbox";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
const FORCE = !!process.env.FORCE;

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => { stderr += c.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-2000)}`)));
  });
}

function commonOutOpts() {
  if (ENCODER === "h264_videotoolbox") {
    return [
      "-c:v", "h264_videotoolbox",
      "-b:v", "6M",
      "-pix_fmt", "yuv420p",
      "-r", String(TARGET_FPS),
    ];
  }
  return [
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(TARGET_FPS),
  ];
}

// Construit le filtre vidéo et la durée cible pour une scène donnée.
// On normalise tout en 1280x720 24fps yuv420p pour permettre un concat -c copy.
function buildFilter(scene) {
  const { action, voice_dur, clip_dur, speed_factor } = scene;
  const scale = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const fadeOut = `fade=out:st=${Math.max(0, voice_dur - FADE_OUT_S).toFixed(3)}:d=${FADE_OUT_S}`;

  if (action === "trim") {
    return {
      filter: `${scale},trim=duration=${voice_dur},setpts=PTS-STARTPTS,${fadeOut},fps=${TARGET_FPS}`,
      duration: voice_dur,
    };
  }
  if (action === "keep") {
    return {
      filter: `${scale},setpts=PTS-STARTPTS,${fadeOut},fps=${TARGET_FPS}`,
      duration: voice_dur,
    };
  }
  if (action === "slow") {
    // factor = voice_dur / clip_dur (déjà ≤ 1.4)
    const factor = speed_factor;
    return {
      filter: `${scale},setpts=${factor.toFixed(4)}*PTS,trim=duration=${voice_dur},setpts=PTS-STARTPTS,${fadeOut},fps=${TARGET_FPS}`,
      duration: voice_dur,
    };
  }
  // extend : on étire au max MAX_SLOW× (clip_dur*1.4), puis on gèle la dernière frame
  const stretched = clip_dur * MAX_SLOW;
  const freezeDur = Math.max(0, voice_dur - stretched);
  return {
    filter: `${scale},setpts=${MAX_SLOW.toFixed(4)}*PTS,tpad=stop_mode=clone:stop_duration=${freezeDur.toFixed(3)},trim=duration=${voice_dur},setpts=PTS-STARTPTS,${fadeOut},fps=${TARGET_FPS}`,
    duration: voice_dur,
  };
}

async function encodeSegment(scene) {
  const idStr = String(scene.id).padStart(3, "0");
  const outPath = path.join(SEG_DIR, `${idStr}.mp4`);
  if (!FORCE && existsSync(outPath) && statSync(outPath).size > 1024) {
    return { id: scene.id, outPath, skipped: true };
  }
  const clipPath = path.join(ROOT, scene.clip_file);
  if (!existsSync(clipPath)) throw new Error(`missing clip: ${clipPath}`);

  const { filter, duration } = buildFilter(scene);
  const args = [
    "-i", clipPath,
    "-an",
    "-vf", filter,
    "-t", duration.toFixed(3),
    ...commonOutOpts(),
    outPath,
  ];
  await runFFmpeg(args);
  return { id: scene.id, outPath, skipped: false };
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message, item: items[i] };
      }
      done++;
      const pct = ((done / items.length) * 100).toFixed(1);
      process.stdout.write(`\r  segments: ${done}/${items.length} (${pct}%)`);
    }
  }));
  process.stdout.write("\n");
  return results;
}

async function main() {
  if (!existsSync(PLAN_PATH)) { console.error(`plan introuvable: ${PLAN_PATH}`); process.exit(1); }
  if (!existsSync(VOICEOVER)) { console.error(`voiceover introuvable: ${VOICEOVER}`); process.exit(1); }
  mkdirSync(SEG_DIR, { recursive: true });

  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf-8"));
  const scenes = plan.scenes.filter((s) => s.clip_file);
  console.log(`Encodeur: ${ENCODER}, concurrency: ${CONCURRENCY}`);
  console.log(`Scenes à encoder: ${scenes.length}`);

  const t0 = Date.now();
  const results = await withConcurrency(scenes, CONCURRENCY, encodeSegment);
  const errs = results.filter((r) => r?.error);
  if (errs.length) {
    console.error(`\n[!] ${errs.length} segments en erreur:`);
    for (const e of errs.slice(0, 5)) console.error(`  scene ${e.item.id}: ${e.error.slice(0, 300)}`);
    process.exit(1);
  }
  const skipped = results.filter((r) => r?.skipped).length;
  console.log(`Encodage segments: ${((Date.now() - t0) / 1000).toFixed(1)}s (${results.length - skipped} encodés, ${skipped} cache)`);

  // Concat
  const concatLines = scenes
    .map((s) => `file '${path.join(SEG_DIR, String(s.id).padStart(3, "0") + ".mp4").replace(/'/g, "'\\''")}'`)
    .join("\n");
  writeFileSync(CONCAT_LIST, concatLines);

  console.log("Mux final (concat + voiceover)…");
  const tMux = Date.now();
  await runFFmpeg([
    "-f", "concat", "-safe", "0", "-i", CONCAT_LIST,
    "-i", VOICEOVER,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    FINAL_OUT,
  ]);
  console.log(`Mux: ${((Date.now() - tMux) / 1000).toFixed(1)}s`);
  console.log(`\n-> ${path.relative(ROOT, FINAL_OUT)}`);
}

main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
