#!/usr/bin/env node
/**
 * remix-medieval-2min.mjs — remonte les scenes 11-15 du vieux job (seedance)
 * avec :
 *   - shots de 3s max (au lieu de 5-7s bruts)
 *   - split des clips en segments successifs (0-3s, 3-6s, ...) pour varier
 *   - pas de sous-titres
 *   - voix off decoupee a partir de la scene 11 (offset = 245s)
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const ROOT = "/Users/stephanezayat/Documents/youtube-freedom-factory";
const OLD_JOB = path.join(ROOT, "public/generated/old/job_caesar_full");
const OUT_DIR = path.join(ROOT, "public/generated/remix_scene11_2min");
const SCENES = [11, 12, 13, 14, 15];
const SHOT_LEN = 3;         // shot target : 3s
const FPS = 24;
const VOICE_OFFSET = 245;   // scene 11 commence a 245s de voiceover

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const TMP_DIR = path.join(OUT_DIR, "tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const script = JSON.parse(readFileSync(path.join(OLD_JOB, "script.json"), "utf-8"));
const clipsDir = path.join(OLD_JOB, "clips");

// Recupere la duree reelle d'un clip via ffprobe
function clipDuration(p) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf-8" });
  return parseFloat(out.trim());
}

// Plan : pour chaque scene, cycle a travers ses clips en extrayant des segments de SHOT_LEN.
// Chaque clip peut etre split : clip de 7s → segments 0-3, 3-6 (drop dernier 1s).
const plan = [];
for (const sceneIdx of SCENES) {
  const sc = script.scenes[sceneIdx];
  const sceneDur = sc.durationSeconds;
  const clipFiles = readdirSync(clipsDir)
    .filter((f) => f.startsWith(`clip_${String(sceneIdx).padStart(3, "0")}_`))
    .sort();

  // Construis la liste des segments disponibles (clip, startSec, duration)
  const availableSegments = [];
  for (const f of clipFiles) {
    const fp = path.join(clipsDir, f);
    const d = clipDuration(fp);
    let t = 0;
    while (t + SHOT_LEN <= d + 0.5) {
      const segDur = Math.min(SHOT_LEN, d - t);
      if (segDur >= 1.5) availableSegments.push({ file: fp, start: t, dur: segDur });
      t += SHOT_LEN;
    }
  }

  // Remplis la scene en cyclant les segments
  let cumul = 0;
  let i = 0;
  while (cumul < sceneDur - 0.1) {
    const remaining = sceneDur - cumul;
    const seg = availableSegments[i % availableSegments.length];
    const useDur = Math.min(seg.dur, remaining);
    plan.push({ scene: sceneIdx, file: seg.file, start: seg.start, dur: useDur });
    cumul += useDur;
    i++;
  }
  console.log(`scene ${sceneIdx}: ${sc.durationSeconds}s → ${availableSegments.length} segments dispos, ${plan.filter((p) => p.scene === sceneIdx).length} shots utilises`);
}

const totalVideo = plan.reduce((s, p) => s + p.dur, 0);
console.log(`\nTotal video : ${plan.length} shots, ${totalVideo.toFixed(1)}s`);

// Extrait chaque shot en .ts (facile a concat)
const shotFiles = [];
for (let i = 0; i < plan.length; i++) {
  const p = plan[i];
  const shotPath = path.join(TMP_DIR, `shot_${String(i).padStart(3, "0")}.ts`);
  const cmd = `ffmpeg -y -ss ${p.start.toFixed(3)} -i "${p.file}" -t ${p.dur.toFixed(3)} -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=${FPS},setsar=1" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -an -f mpegts "${shotPath}"`;
  execSync(cmd, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
  shotFiles.push(shotPath);
  if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${plan.length} shots encoded`);
}
console.log(`  ${plan.length}/${plan.length} shots encoded`);

// Concat all shots
const concatList = path.join(TMP_DIR, "concat.txt");
writeFileSync(concatList, shotFiles.map((f) => `file '${path.resolve(f)}'`).join("\n"));

const videoOnly = path.join(OUT_DIR, "video_only.mp4");
execSync(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -an -movflags +faststart "${videoOnly}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });

// Extrait l'audio a partir de VOICE_OFFSET pour la duree totalVideo
const voiceover = path.join(OLD_JOB, "voiceover.mp3");
const audioSlice = path.join(TMP_DIR, "audio_slice.mp3");
execSync(`ffmpeg -y -ss ${VOICE_OFFSET} -i "${voiceover}" -t ${totalVideo.toFixed(3)} -c:a copy "${audioSlice}"`, { stdio: "pipe" });

// Mux video + audio
const finalPath = path.join(OUT_DIR, "output.mp4");
execSync(`ffmpeg -y -i "${videoOnly}" -i "${audioSlice}" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${finalPath}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });

// Cleanup
for (const f of shotFiles) { try { unlinkSync(f); } catch {} }
try { unlinkSync(concatList); } catch {}
try { unlinkSync(audioSlice); } catch {}

const size = execSync(`du -h "${finalPath}" | awk '{print $1}'`, { encoding: "utf-8" }).trim();
console.log(`\n✅ Output: ${finalPath} (${size}, ${totalVideo.toFixed(1)}s)`);
