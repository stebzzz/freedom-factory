#!/usr/bin/env node
// Best-effort montage for a WAN-completed job.
//
// Usage:
//   node scripts/montage-wan.mjs <jobId> <audioPath>
//
// What it does:
//   1. Runs whisper-cli on the audio → word-level transcript JSON
//   2. Aligns each scene of script.json onto the real voiceover timing (sequential word match)
//   3. Generates ASS subtitles (yellow word-highlight style, burned-in via libass)
//   4. Pre-encodes each scene as a Ken-Burns clip (concurrent batches)
//   5. Concats all clips with concat demuxer + mixes audio + burns ASS
//
// Output:
//   public/generated/<jobId>/final.mp4

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const WHISPER_BIN = process.env.WHISPER_CLI_PATH || "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH || path.join(os.homedir(), ".cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin");
const FPS = 24;
const RES_W = 1920;
const RES_H = 1080;
const ZOOM_RANGE = 0.04;   // 4% zoom over scene duration
const CLIP_CONC = 6;       // concurrent clip encodings (hw encoder handles parallelism well)
const USE_HW = process.env.MONTAGE_SW !== "1"; // Apple Silicon h264_videotoolbox (5-10x faster)

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    if (!opts.inherit) child.stderr?.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (err) => reject(new Error(`${cmd} spawn: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function normalize(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(s) { return normalize(s).split(" ").filter(Boolean); }

function parseWhisperJson(raw) {
  const segments = [];
  for (const seg of raw.transcription ?? []) {
    if (!seg.offsets) continue;
    segments.push({ start: seg.offsets.from / 1000, end: seg.offsets.to / 1000, text: (seg.text || "").trim() });
  }
  return { segments };
}

function expandToWords(segments) {
  const words = [];
  for (const seg of segments) {
    const t = tokens(seg.text);
    if (t.length === 0) continue;
    const dur = seg.end - seg.start;
    const per = dur / t.length;
    for (let i = 0; i < t.length; i++) {
      words.push({ word: t[i], start: seg.start + i * per, end: seg.start + (i + 1) * per });
    }
  }
  return words;
}

async function transcribe(audioPath) {
  const outBase = audioPath.replace(/\.[^.]+$/, "") + ".whisper";
  const jsonPath = `${outBase}.json`;
  // Idempotent: reuse cached transcript if it exists (whisper takes ~50s for 12 min audio).
  try {
    await stat(jsonPath);
    console.log(`[whisper] cached transcript reused: ${path.basename(jsonPath)}`);
    const raw = JSON.parse(await readFile(jsonPath, "utf-8"));
    return parseWhisperJson(raw);
  } catch { /* re-run */ }
  console.log(`[whisper] transcribe ${path.basename(audioPath)}`);
  await run(WHISPER_BIN, [
    "-m", WHISPER_MODEL,
    "-l", "auto",
    "-oj",
    "-of", outBase,
    "-sow",
    audioPath,
  ]);
  const raw = JSON.parse(await readFile(jsonPath, "utf-8"));
  return parseWhisperJson(raw);
}

function alignScenes(scenes, transcript) {
  const timed = expandToWords(transcript.segments);
  const totalAudio = transcript.segments[transcript.segments.length - 1].end;
  if (timed.length === 0) throw new Error("align: empty transcript");

  // === GLOBAL PROPORTIONAL MAPPING (drift-free by construction)
  // Premise: when the voice actor reads the script faithfully, script and transcript word
  // counts roughly match (here 1552 vs 1556 → ratio ≈ 1.0). Mapping each scene's
  // cumulative script-word index to the transcript timeline gives sub-second sync
  // across the WHOLE video, with bounded error proportional to (1 - script_words/transcript_words).
  // No cursor drift, no compounding anchors. Single-pass.
  const cumScript = [0];
  for (const s of scenes) cumScript.push(cumScript[cumScript.length - 1] + tokens(s.narration).length);
  const S = cumScript[cumScript.length - 1];
  const T = timed.length;
  if (S === 0 || T === 0) throw new Error("align: empty script or transcript words");

  const startTimeAt = (cumIdx) => {
    const tIdx = Math.min(T - 1, Math.max(0, Math.floor((cumIdx / S) * T)));
    return timed[tIdx].start;
  };

  for (let i = 0; i < scenes.length; i++) {
    const start = startTimeAt(cumScript[i]);
    const nextStart = i + 1 < scenes.length ? startTimeAt(cumScript[i + 1]) : totalAudio;
    let dur = nextStart - start;
    if (!Number.isFinite(dur) || dur <= 0) dur = 0.8;
    dur = Math.max(0.7, Math.min(4.5, dur));
    scenes[i].durationSeconds = Number(dur.toFixed(3));
    scenes[i]._start = start;
  }

  // Final exact-fit normalization to audio length (post-clamp).
  const sum = scenes.reduce((a, s) => a + s.durationSeconds, 0);
  if (sum > 0 && Math.abs(sum - totalAudio) > 0.5) {
    const factor = totalAudio / sum;
    for (const s of scenes) s.durationSeconds = Number((s.durationSeconds * factor).toFixed(3));
    console.log(`[align] normalized × ${factor.toFixed(3)} (was ${sum.toFixed(1)}s → ${totalAudio.toFixed(1)}s)`);
  }

  console.log(`[align] script=${S} words · transcript=${T} words · ratio=${(S / T).toFixed(3)}`);
  const durs = scenes.map((s) => s.durationSeconds).sort((a, b) => a - b);
  const q = (p) => durs[Math.floor(durs.length * p)];
  console.log(`[align] durations: min=${q(0).toFixed(2)}s p25=${q(0.25).toFixed(2)}s median=${q(0.5).toFixed(2)}s p75=${q(0.75).toFixed(2)}s max=${q(0.999).toFixed(2)}s`);
  return totalAudio;
}

function alignScenesLegacy_unused(scenes, transcript) {
  const timed = expandToWords(transcript.segments);
  const totalAudio = transcript.segments[transcript.segments.length - 1].end;
  if (timed.length === 0) throw new Error("align: empty transcript");

  // === Pass 1: ANCHOR scenes whose first word matches strongly (close to cursor + corroborated).
  // Mark sceneStarts[i] = null when no reliable anchor — we'll fill those proportionally in Pass 2.
  // The key insight: an unreliable match (long lookahead OR no corroboration from 2nd word) is
  // WORSE than no match at all, because it locks in a drift that propagates forever.
  const sceneStarts = new Array(scenes.length).fill(null);
  let cursor = 0;
  const STRICT_LOOKAHEAD = 6;  // first-word match must be within this window of cursor
  for (let i = 0; i < scenes.length; i++) {
    const sw = tokens(scenes[i].narration);
    if (sw.length === 0) continue;

    let j = cursor;
    let look = 0;
    while (j < timed.length && timed[j].word !== sw[0] && look < STRICT_LOOKAHEAD) { j++; look++; }
    const firstMatched = j < timed.length && timed[j].word === sw[0];

    // Corroborate: 2nd narration word should be within the next 3 transcript words.
    let corroborated = sw.length === 1 ? true : false;
    if (firstMatched && sw.length >= 2) {
      for (let k = 1; k <= 3 && j + k < timed.length; k++) {
        if (timed[j + k].word === sw[1]) { corroborated = true; break; }
      }
    }
    if (firstMatched && corroborated) {
      sceneStarts[i] = timed[j].start;
      cursor = j + 1;
    }

    // Always advance cursor through the scene's words (whether anchored or not) so the
    // search window for the next scene moves forward naturally.
    let k = firstMatched && corroborated ? 1 : 0;
    let walker = firstMatched && corroborated ? j + 1 : j;
    while (k < sw.length && walker < timed.length) {
      let l = 0;
      while (walker < timed.length && timed[walker].word !== sw[k] && l < 4) { walker++; l++; }
      if (walker < timed.length && timed[walker].word === sw[k]) walker++;
      k++;
    }
    cursor = Math.max(cursor, walker);
  }

  // Guarantee endpoints so block distribution works.
  if (sceneStarts[0] === null) sceneStarts[0] = 0;

  // === Pass 2: For each gap between anchored scenes, distribute time PROPORTIONALLY
  // to each scene's narration word count. This means: at every anchor, we re-sync to
  // ground truth → no cumulative drift. Between anchors, the local pace adapts to how
  // many words each scene has.
  const anchorIdx = [];
  for (let i = 0; i < scenes.length; i++) if (sceneStarts[i] !== null) anchorIdx.push(i);
  anchorIdx.push(scenes.length); // sentinel = end of audio

  for (let a = 0; a < anchorIdx.length - 1; a++) {
    const lo = anchorIdx[a];
    const hi = anchorIdx[a + 1];
    const tLo = sceneStarts[lo];
    const tHi = hi < scenes.length ? sceneStarts[hi] : totalAudio;
    if (hi === lo + 1) continue; // no gap
    const block = scenes.slice(lo, hi);
    const totalW = block.reduce((s, sc) => s + Math.max(1, tokens(sc.narration).length), 0);
    let cum = tLo;
    for (let i = 0; i < block.length; i++) {
      const w = Math.max(1, tokens(block[i].narration).length);
      sceneStarts[lo + i] = cum;
      cum += ((tHi - tLo) * w) / totalW;
    }
  }

  // === Pass 3: Durations = intervals between consecutive starts, clamped per-scene.
  // Clamps prevent both flash-frames (mismatched alignment grabbing tiny intervals) and
  // frozen mega-scenes (alignment swallowing pauses).
  const MIN_DUR = 0.8;
  const MAX_DUR = 4.0;
  for (let i = 0; i < scenes.length; i++) {
    const start = sceneStarts[i] ?? (i > 0 ? sceneStarts[i - 1] : 0);
    const nextStart = i + 1 < scenes.length ? (sceneStarts[i + 1] ?? totalAudio) : totalAudio;
    let dur = nextStart - start;
    if (!Number.isFinite(dur) || dur <= 0) dur = MIN_DUR;
    dur = Math.max(MIN_DUR, Math.min(MAX_DUR, dur));
    scenes[i].durationSeconds = Number(dur.toFixed(3));
    scenes[i]._start = start;
  }

  // === Pass 4: Final exact-fit normalization to audio length.
  const sum = scenes.reduce((a, s) => a + s.durationSeconds, 0);
  if (sum > 0 && Math.abs(sum - totalAudio) > 0.5) {
    const factor = totalAudio / sum;
    for (const s of scenes) {
      s.durationSeconds = Number((s.durationSeconds * factor).toFixed(3));
    }
    console.log(`[align] normalized × ${factor.toFixed(3)} (was ${sum.toFixed(1)}s → ${totalAudio.toFixed(1)}s)`);
  }

  const anchored = anchorIdx.length - 1;
  console.log(`[align] ${anchored}/${scenes.length} scenes anchored (${((anchored / scenes.length) * 100).toFixed(0)}%); the rest distributed proportionally by word count`);
  const durs = scenes.map((s) => s.durationSeconds).sort((a, b) => a - b);
  const q = (p) => durs[Math.floor(durs.length * p)];
  console.log(`[align] durations: min=${q(0).toFixed(2)}s p25=${q(0.25).toFixed(2)}s median=${q(0.5).toFixed(2)}s p75=${q(0.75).toFixed(2)}s max=${q(0.999).toFixed(2)}s`);
  return totalAudio;
}

function secondsToAss(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, "0")}:${String(parseFloat(s).toFixed(2)).padStart(5, "0")}`;
}

function buildASS(scenes) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,64,&H0000FFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,80,80,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  let cursor = 0;
  const lines = [];
  for (const s of scenes) {
    const dur = s.durationSeconds || 0;
    if (dur <= 0 || !s.narration) { cursor += dur; continue; }
    const start = cursor;
    const end = cursor + dur;
    // Escape commas and braces
    const txt = s.narration.replace(/[\r\n]+/g, " ").replace(/\{/g, "(").replace(/\}/g, ")");
    lines.push(`Dialogue: 0,${secondsToAss(start)},${secondsToAss(end)},Default,,0,0,0,,${txt}`);
    cursor += dur;
  }
  return header + lines.join("\n") + "\n";
}

async function buildClip(imagePath, dur, outPath) {
  // FAST PATH: static scale + crop, no Ken Burns.
  // Why: with 1.5s avg per scene, the zoom motion is imperceptible vs the cut cadence —
  // KB costs 6s+/clip via zoompan filter (cumulative 2h+ for 399 clips), drop it entirely.
  // The dynamism comes from the rapid cuts and burned-in subtitles, not in-scene zoom.
  // To re-enable KB later, set env MONTAGE_KB=1.
  const useKB = process.env.MONTAGE_KB === "1";
  const frames = Math.max(2, Math.round(dur * FPS));
  const vf = useKB
    ? [
        `scale=${Math.round(RES_W * 1.25)}:${Math.round(RES_H * 1.25)}:force_original_aspect_ratio=increase`,
        `crop=${Math.round(RES_W * 1.25)}:${Math.round(RES_H * 1.25)}`,
        `zoompan=z='min(zoom+${(ZOOM_RANGE / frames).toFixed(6)},1+${ZOOM_RANGE})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${RES_W}x${RES_H}:fps=${FPS}`,
        `format=yuv420p`,
      ].join(",")
    : [
        `scale=${RES_W}:${RES_H}:force_original_aspect_ratio=increase`,
        `crop=${RES_W}:${RES_H}`,
        `format=yuv420p`,
        `fps=${FPS}`,
      ].join(",");
  await run("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-loop", "1",
    "-t", String(dur),
    "-i", imagePath,
    "-vf", vf,
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-an",
    outPath,
  ]);
}

async function concatAndMux(concatFile, audioPath, assPath, outputPath) {
  // Subtitles are OFF by default — set MONTAGE_SUBS=1 to burn them in.
  const withSubs = process.env.MONTAGE_SUBS === "1";
  console.log(`[ffmpeg] final concat + audio${withSubs ? " + subtitles" : ""} → ${path.basename(outputPath)}`);
  const finalCodec = USE_HW
    ? ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-allow_sw", "1"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "20"];
  const args = [
    "-y",
    "-loglevel", "warning",
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-i", audioPath,
  ];
  if (withSubs) {
    const escapedAss = assPath.replace(/'/g, "'\\''").replace(/:/g, "\\:");
    args.push("-vf", `ass='${escapedAss}'`);
  } else {
    // No re-encode needed for video — just copy the concat output. Massive speedup.
    finalCodec.length = 0;
    finalCodec.push("-c:v", "copy");
  }
  args.push(
    "-map", "0:v:0",
    "-map", "1:a:0",
    ...finalCodec,
    ...(withSubs ? ["-pix_fmt", "yuv420p"] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  );
  await run("ffmpeg", args);
}

async function main() {
  const [jobId, audioArg] = process.argv.slice(2);
  if (!jobId || !audioArg) {
    console.error("Usage: node scripts/montage-wan.mjs <jobId> <audioPath>");
    process.exit(1);
  }
  const jobDir = path.join(process.cwd(), "public", "generated", jobId);
  const audioPath = path.isAbsolute(audioArg) ? audioArg : path.join(jobDir, audioArg);
  await stat(audioPath); // verify exists

  const script = JSON.parse(await readFile(path.join(jobDir, "script.json"), "utf-8"));
  const scenes = script.scenes;

  // --- 1) Whisper ---
  console.log(`\n>>> Step 1: Whisper transcribe`);
  const tStart = Date.now();
  const transcript = await transcribe(audioPath);
  console.log(`>>> Whisper ${transcript.segments.length} segments in ${((Date.now()-tStart)/1000).toFixed(1)}s`);

  // --- 2) Align ---
  console.log(`\n>>> Step 2: Align ${scenes.length} scenes to voiceover`);
  const totalAudio = alignScenes(scenes, transcript);
  const sumDur = scenes.reduce((a, s) => a + (s.durationSeconds || 0), 0);
  console.log(`>>> Audio=${totalAudio.toFixed(1)}s · aligned=${sumDur.toFixed(1)}s · avg=${(sumDur/scenes.length).toFixed(2)}s/scene`);

  // Persist updated script.json
  await writeFile(path.join(jobDir, "script.aligned.json"), JSON.stringify({ ...script, scenes, totalAudioSec: totalAudio }, null, 2));
  console.log(`>>> script.aligned.json written`);

  // --- 3) ASS subtitles ---
  console.log(`\n>>> Step 3: Generate ASS subtitles`);
  const assPath = path.join(jobDir, "subtitles.ass");
  await writeFile(assPath, buildASS(scenes));
  console.log(`>>> ${assPath}`);

  // --- 4) Per-scene clips ---
  console.log(`\n>>> Step 4: Pre-encode ${scenes.length} Ken-Burns clips (concurrency=${CLIP_CONC})`);
  const clipsDir = path.join(jobDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const concatLines = [];
  let done = 0;
  const tClips = Date.now();
  const tasks = scenes.map((scene) => ({ scene, clip: path.join(clipsDir, `clip_${String(scene.index).padStart(3, "0")}.mp4`), img: path.join(jobDir, "images", `scene_${String(scene.index).padStart(3, "0")}.png`) }));

  // Build concat file in scene-index order
  for (const t of tasks) concatLines.push(`file '${t.clip.replace(/'/g, "'\\''")}'`);
  const concatFile = path.join(jobDir, "concat.txt");
  await writeFile(concatFile, concatLines.join("\n") + "\n");

  // Encode clips concurrently
  for (let i = 0; i < tasks.length; i += CLIP_CONC) {
    const batch = tasks.slice(i, i + CLIP_CONC);
    await Promise.all(batch.map(async ({ scene, clip, img }) => {
      try { await stat(clip); /* skip existing */ }
      catch {
        try { await stat(img); }
        catch { console.warn(`  scene ${scene.index} MISSING image, skipping`); return; }
        await buildClip(img, scene.durationSeconds || 1.5, clip);
      }
      done += 1;
      if (done % 30 === 0 || done === tasks.length) {
        const elapsed = (Date.now() - tClips) / 1000;
        const rate = done / elapsed;
        const eta = Math.ceil((tasks.length - done) / rate);
        console.log(`  [clips] ${done}/${tasks.length} · ${elapsed.toFixed(0)}s · ETA ${eta}s`);
      }
    }));
  }
  console.log(`>>> Clips done in ${((Date.now()-tClips)/1000).toFixed(1)}s`);

  // --- 5) Concat + audio + subtitles ---
  console.log(`\n>>> Step 5: Final concat + audio mux + burn subtitles`);
  const outputPath = path.join(jobDir, "final.mp4");
  const tFinal = Date.now();
  await concatAndMux(concatFile, audioPath, assPath, outputPath);
  console.log(`>>> Final mux ${((Date.now()-tFinal)/1000).toFixed(1)}s`);

  // Stats
  const sizeBytes = (await stat(outputPath)).size;
  console.log(`\n✅ DONE — ${outputPath}`);
  console.log(`   ${(sizeBytes/1024/1024).toFixed(1)} MB · ${totalAudio.toFixed(1)}s · ${scenes.length} scenes`);
  console.log(`   Total time: ${((Date.now()-tStart)/1000/60).toFixed(1)} min`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
