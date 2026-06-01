import ffmpeg from "fluent-ffmpeg";
import { writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ArchiveItem, MontageResult, ScriptScene } from "@/lib/pipeline/types";

interface MontageInput {
  audioPath?: string;            // voiceover. Optional: omit to skip voiceover entirely (silent or clip-audio only)
  musicPath?: string;
  images: Array<{ imagePath: string; sceneIndex: number }>;
  brollImages?: Array<{ imagePath: string; sceneIndex: number }>;
  clips?: Array<{ clipPath: string; sceneIndex: number; isMock?: boolean; durationSeconds?: number; clipIndex?: number }>;
  archives?: ArchiveItem[];
  scenes: ScriptScene[];
  outputPath: string;
  srtPath?: string;
  kenBurns?: boolean;
  // Preset-driven options
  kenBurnsSpeed?: number;        // zoom range: 0.04 (slow) to 0.18 (fast). Default 0.04
  transitionType?: "crossfade" | "hard-cut" | "dip-to-black";
  transitionDuration?: number;   // seconds. Default 0
  musicVolume?: number;          // 0.0-1.0. Default 0.15
  subtitlesEnabled?: boolean;    // generate SRT subtitles. Default true
  particlePath?: string;         // particle overlay video (black bg, looped)
  keepClipAudio?: boolean;       // when true, preserve audio from Veo3 clip segments in the final mix (default: drop clip audio)
}

// -------------------------------------------------------------------
// Visual segment: one visual "shot" in the final montage timeline
// -------------------------------------------------------------------
interface VisualSegment {
  type: "image" | "clip";       // image = Ken Burns still, clip = Wan animated video
  filePath: string;
  durationSeconds: number;
  motionIndex: number;           // which KB_MOTION pattern to use (ignored for clips)
}

// -------------------------------------------------------------------
// Ken Burns — smooth zoom in / zoom out alternés (pas de pan)
// IMPORTANT: trim+setpts après zoompan pour forcer la durée exacte
// -------------------------------------------------------------------
function buildKBFilter(d: number, z: number, fps: number, motionIndex: number): string {
  const speed = (z / d).toFixed(8);
  const cx = "floor(iw/2-(iw/zoom/2))";
  const cy = "floor(ih/2-(ih/zoom/2))";
  const isZoomIn = motionIndex % 2 === 0;
  const zExpr = isZoomIn
    ? `1.0+on*${speed}`
    : `${(1 + z).toFixed(4)}-on*${speed}`;
  const durSec = (d / fps).toFixed(4);
  return `scale=3840:2160,zoompan=z='${zExpr}':x='${cx}':y='${cy}':d=${d}:s=1920x1080:fps=${fps},setsar=1,trim=duration=${durSec},setpts=PTS-STARTPTS`;
}

// -------------------------------------------------------------------
// Build the visual timeline — interleave main images, B-roll, clips
// -------------------------------------------------------------------
async function buildTimeline(
  images: Array<{ imagePath: string; sceneIndex: number }>,
  brollImages: Array<{ imagePath: string; sceneIndex: number }> | undefined,
  clips: Array<{ clipPath: string; sceneIndex: number; isMock?: boolean; durationSeconds?: number; clipIndex?: number }> | undefined,
  archives: ArchiveItem[] | undefined,
  scenes: ScriptScene[],
): Promise<VisualSegment[]> {
  const { stat } = await import("fs/promises");
  const segments: VisualSegment[] = [];
  let motionCounter = 0;

  // Index b-roll and clips by scene (skip corrupt files < 50KB)
  const MIN_IMAGE_SIZE = 50_000; // 50KB minimum for a valid image
  const brollByScene = new Map<number, string>();
  if (brollImages) {
    for (const b of brollImages) {
      try {
        const s = await stat(b.imagePath);
        if (s.size >= MIN_IMAGE_SIZE) {
          brollByScene.set(b.sceneIndex, b.imagePath);
        } else {
          console.warn(`[FFmpeg] B-roll scene ${b.sceneIndex} trop petit (${s.size}B), skip`);
        }
      } catch { /* skip missing files */ }
    }
  }

  // Index archives par scène
  const archiveByScene = new Map<number, ArchiveItem>();
  if (archives) {
    for (const a of archives) {
      try {
        const s = await stat(a.filePath);
        if (s.size >= (a.type === "video" ? 5000 : MIN_IMAGE_SIZE)) {
          archiveByScene.set(a.sceneIndex, a);
        }
      } catch { /* skip missing files */ }
    }
  }

  // Grouper les clips par scène, triés par clipIndex (support multi-clips par scène)
  const clipsByScene = new Map<number, Array<{ path: string; dur: number; idx: number }>>();
  clips?.filter((c) => !c.isMock).forEach((c) => {
    if (!clipsByScene.has(c.sceneIndex)) clipsByScene.set(c.sceneIndex, []);
    clipsByScene.get(c.sceneIndex)!.push({ path: c.clipPath, dur: c.durationSeconds || 6, idx: c.clipIndex ?? 0 });
  });
  clipsByScene.forEach((arr) => arr.sort((a, b) => a.idx - b.idx));

  for (const scene of scenes) {
    const mainImg = images.find((img) => img.sceneIndex === scene.index);
    const broll = brollByScene.get(scene.index);
    const archive = archiveByScene.get(scene.index);
    const sceneClips = clipsByScene.get(scene.index) || [];
    const sceneDur = scene.durationSeconds;

    // T2V mode: scenes have clips but no generated stills. Build timeline from clips alone.
    if (!mainImg && sceneClips.length === 0 && !archive && !broll) continue;

    if (sceneClips.length > 0 && !mainImg && !archive && !broll) {
      // Pure clips path — no still fallback needed
      let filled = 0;
      for (const clip of sceneClips) {
        const remaining = sceneDur - filled;
        if (remaining <= 0.1) break;
        const clipDur = Math.min(clip.dur, remaining);
        segments.push({ type: "clip", filePath: clip.path, durationSeconds: clipDur, motionIndex: 0 });
        filled += clipDur;
      }
      // If clips don't fill the scene duration, stretch the last clip
      const remaining = sceneDur - filled;
      if (remaining > 0.1 && segments.length > 0) {
        segments[segments.length - 1].durationSeconds += remaining;
      }
      continue;
    }

    if (!mainImg) continue;

    if (sceneClips.length > 0) {
      // Chaîner tous les clips de la scène — pas de boucle sur le même clip
      let filled = 0;
      for (const clip of sceneClips) {
        const remaining = sceneDur - filled;
        if (remaining <= 0.1) break;
        const clipDur = Math.min(clip.dur, remaining);
        segments.push({ type: "clip", filePath: clip.path, durationSeconds: clipDur, motionIndex: 0 });
        filled += clipDur;
      }
      // Archive dans le temps KB restant (si dispo)
      const remaining = sceneDur - filled;
      if (remaining > 0.1 && archive) {
        const archDur = archive.type === "video"
          ? Math.min(archive.durationSeconds || 4, remaining * 0.5)
          : Math.min(4, remaining * 0.4);
        segments.push({
          type: archive.type === "video" ? "clip" : "image",
          filePath: archive.filePath,
          durationSeconds: archDur,
          motionIndex: motionCounter++,
        });
        const kbRemaining = remaining - archDur;
        if (kbRemaining > 0.1) {
          const fallbackImg = broll || mainImg.imagePath;
          segments.push({ type: "image", filePath: fallbackImg, durationSeconds: kbRemaining, motionIndex: motionCounter++ });
        }
      } else if (remaining > 0.1) {
        const fallbackImg = broll || mainImg.imagePath;
        segments.push({ type: "image", filePath: fallbackImg, durationSeconds: remaining, motionIndex: motionCounter++ });
      }
    } else if (archive) {
      // Archive disponible : main KB + archive + broll KB
      const archDur = archive.type === "video"
        ? Math.min(archive.durationSeconds || 4, sceneDur * 0.3)
        : Math.min(4, sceneDur * 0.2);
      const mainDur = broll ? sceneDur * 0.5 : sceneDur - archDur;
      const brollDur = broll ? sceneDur - mainDur - archDur : 0;

      segments.push({ type: "image", filePath: mainImg.imagePath, durationSeconds: mainDur, motionIndex: motionCounter++ });
      segments.push({
        type: archive.type === "video" ? "clip" : "image",
        filePath: archive.filePath,
        durationSeconds: archDur,
        motionIndex: motionCounter++,
      });
      if (broll && brollDur > 0.5) {
        segments.push({ type: "image", filePath: broll, durationSeconds: brollDur, motionIndex: motionCounter++ });
      }
    } else if (broll) {
      // Pas de clip ni archive : main KB + broll KB
      const mainDur = sceneDur * 0.55;
      const brollDur = sceneDur * 0.45;
      segments.push({ type: "image", filePath: mainImg.imagePath, durationSeconds: mainDur, motionIndex: motionCounter++ });
      segments.push({ type: "image", filePath: broll, durationSeconds: brollDur, motionIndex: motionCounter++ });
    } else {
      // Image seule — Ken Burns pleine scène
      segments.push({ type: "image", filePath: mainImg.imagePath, durationSeconds: sceneDur, motionIndex: motionCounter++ });
    }
  }

  return segments;
}

// ===================================================================
// PUBLIC: assembleMontage
// ===================================================================
export async function assembleMontage(
  input: MontageInput,
  onProgress: (percent: number) => void,
): Promise<MontageResult> {
  const { audioPath, musicPath, images, brollImages, clips, archives, scenes, outputPath } = input;

  const concatDir = path.dirname(outputPath);

  // Generate SRT subtitles (skip if disabled)
  const subtitlesEnabled = input.subtitlesEnabled !== false;
  let subtitlePath = input.srtPath;
  if (subtitlesEnabled && !subtitlePath) {
    subtitlePath = path.join(concatDir, "subtitles.srt");
    await writeFile(subtitlePath, generateSRT(scenes));
    console.log(`[FFmpeg] SRT genere: ${subtitlePath}`);
  } else if (!subtitlesEnabled) {
    console.log(`[FFmpeg] Sous-titres desactives`);
  }

  const totalDuration = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);

  // Sort inputs
  const sortedImages = [...images].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const sortedBroll = brollImages ? [...brollImages].sort((a, b) => a.sceneIndex - b.sceneIndex) : undefined;
  const sortedClips = clips ? [...clips].sort((a, b) => a.sceneIndex - b.sceneIndex) : undefined;

  // Build the visual timeline
  const timeline = await buildTimeline(sortedImages, sortedBroll, sortedClips, archives, scenes);
  console.log(`[FFmpeg] Timeline: ${timeline.length} segments (${timeline.filter((s) => s.type === "clip").length} clips, ${timeline.filter((s) => s.type === "image").length} images)`);

  const transitionType = input.transitionType || "hard-cut";
  const transitionDuration = input.transitionDuration || 0;
  const kenBurnsSpeed = input.kenBurnsSpeed ?? 0.04;
  const musicVolume = input.musicVolume ?? 0.15;

  // Particle overlay path
  const particlePath = input.particlePath
    || path.join(process.cwd(), "public", "9665235-hd_1920_1080_25fps.mp4");
  const hasParticles = existsSync(particlePath);
  if (hasParticles) console.log(`[FFmpeg] Particules overlay: ${particlePath}`);

  // ASS subtitles for burned-in yellow text
  const assPath = path.join(concatDir, "subtitles.ass");
  if (subtitlesEnabled) {
    await writeFile(assPath, generateASS(scenes));
    console.log(`[FFmpeg] ASS sous-titres generés: ${assPath}`);
  }

  const keepClipAudio = input.keepClipAudio === true;

  return new Promise<MontageResult>((resolve, reject) => {
    // Above ~120 stills the dynamic montage tries to load every PNG at once
    // (-loop 1 -i ... × N) and the kernel OOM-kills ffmpeg with SIGKILL. Skip
    // straight to the streaming concat-demuxer fallback for big slideshows.
    // The image-only path doesn't get Ken Burns/transitions, but it actually
    // completes — and a finished file beats an OOM crash.
    const tooManyStills = timeline.length > 120 && timeline.every((s) => s.type === "image");
    const tryDynamic = !tooManyStills;

    const runFallback = (reason: string) => {
      console.warn(`[FFmpeg] Fallback simple slideshow — ${reason}`);
      if (!audioPath) {
        return reject(new Error("Fallback montage requires audioPath. Provide voiceover."));
      }
      buildMontageSimple(sortedImages, audioPath, scenes, outputPath, totalDuration, onProgress, resolve, reject, concatDir);
    };

    if (!tryDynamic) {
      return runFallback(`${timeline.length} images > 120, dynamic path would OOM`);
    }

    try {
      buildDynamicMontage(
        timeline, audioPath, musicPath, outputPath, totalDuration, onProgress,
        resolve,
        (err) => {
          // Async ffmpeg error path — retry with simple slideshow on OOM / SIGKILL.
          const msg = err.message;
          if (/SIGKILL|ENOMEM|Cannot allocate memory|killed/i.test(msg)) {
            return runFallback(`dynamic montage killed (${msg.slice(0, 80)})`);
          }
          reject(err);
        },
        transitionType, transitionDuration, kenBurnsSpeed, musicVolume,
        hasParticles ? particlePath : undefined,
        subtitlesEnabled ? assPath : undefined,
        keepClipAudio,
      );
    } catch (err) {
      console.error(`[FFmpeg] Montage erreur:`, err);
      runFallback(`sync throw: ${(err as Error).message}`);
    }
  });
}

// -------------------------------------------------------------------
// Dynamic montage: mixes Ken Burns stills and Wan clips via filter_complex
// -------------------------------------------------------------------
function buildDynamicMontage(
  timeline: VisualSegment[],
  audioPath: string | undefined,
  musicPath: string | undefined,
  outputPath: string,
  totalDuration: number,
  onProgress: (p: number) => void,
  resolve: (r: MontageResult) => void,
  reject: (e: Error) => void,
  transitionType: "crossfade" | "hard-cut" | "dip-to-black",
  transitionDuration: number,
  zoomRange: number,
  musicVolume: number,
  particlePath?: string,
  assPath?: string,
  keepClipAudio: boolean = false,
) {
  const fps = 24;
  const tempPath = outputPath.replace(/\.mp4$/, "_nosub.mp4");
  const command = ffmpeg();

  // Add all visual inputs (fluent-ffmpeg requires .input() BEFORE .inputOptions())
  // Clips: play once naturally — tpad freezes last frame to fill the scene (no looping replay)
  timeline.forEach((seg) => {
    command.input(seg.filePath);
    if (seg.type === "image") {
      command.inputOptions(["-loop", "1", "-t", String(seg.durationSeconds)]);
    }
  });

  let nextIdx = timeline.length;

  // Particle overlay input (looped)
  let particleIdx = -1;
  if (particlePath) {
    command.input(particlePath);
    command.inputOptions(["-stream_loop", "-1"]);
    particleIdx = nextIdx++;
  }

  // Audio inputs (all optional)
  let voiceoverIndex = -1;
  if (audioPath) {
    voiceoverIndex = nextIdx++;
    command.input(audioPath);
  }

  // Optional background music
  let musicIndex = -1;
  if (musicPath) {
    musicIndex = nextIdx++;
    command.input(musicPath);
  }
  const hasMusicInput = musicIndex >= 0;
  const hasVoiceover = voiceoverIndex >= 0;

  // Build filter_complex
  const filterParts: string[] = [];

  // Step 1: Generate video stream for each segment with trim for exact duration
  timeline.forEach((seg, i) => {
    if (seg.type === "clip") {
      // Freeze last frame past natural EOF so 8s Veo3 clips fill 12-16s scenes without replay
      filterParts.push(
        `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1,tpad=stop_mode=clone:stop_duration=999,trim=duration=${seg.durationSeconds.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`,
      );
    } else {
      const d = Math.round(seg.durationSeconds * fps);
      filterParts.push(`[${i}:v]${buildKBFilter(d, zoomRange, fps, seg.motionIndex)}[v${i}]`);
    }
  });

  // Step 2: Combine segments — crossfade chain or simple concat
  const useCrossfade = transitionType !== "hard-cut" && transitionDuration > 0 && timeline.length > 1;
  const concatOutLabel = particlePath ? "raw" : "outv";

  if (useCrossfade) {
    const xfadeTransition = transitionType === "dip-to-black" ? "fadeblack" : "fade";
    let prevLabel = "v0";
    let cumulativeOffset = timeline[0].durationSeconds - transitionDuration;

    for (let i = 1; i < timeline.length; i++) {
      const outLabel = i === timeline.length - 1 ? concatOutLabel : `x${String(i).padStart(2, "0")}`;
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=${xfadeTransition}:duration=${transitionDuration.toFixed(2)}:offset=${Math.max(0, cumulativeOffset).toFixed(2)}[${outLabel}]`,
      );
      prevLabel = outLabel;
      if (i < timeline.length - 1) {
        cumulativeOffset += timeline[i].durationSeconds - transitionDuration;
      }
    }
  } else {
    const concatInputs = timeline.map((_, i) => `[v${i}]`).join("");
    filterParts.push(`${concatInputs}concat=n=${timeline.length}:v=1:a=0[${concatOutLabel}]`);
  }

  // Step 2b: Particle overlay (colorkey black bg)
  if (particlePath && particleIdx >= 0) {
    filterParts.push(
      `[${particleIdx}:v]scale=1920:1080,fps=${fps},setsar=1,colorkey=0x000000:0.3:0.2,eq=brightness=0.15:saturation=1.2[ptcl_a]`,
    );
    filterParts.push(`[raw]format=yuva420p[raw_a]`);
    filterParts.push(`[raw_a][ptcl_a]overlay=0:0:shortest=1,format=yuv420p[outv]`);
  }

  // Step 3: Audio mixing
  // Sources available: voiceover (audioPath), music (musicPath), clip audio (keepClipAudio + timeline clips)
  // We build each source with its volume, then amix if multiple. Single source goes direct.
  const audioSources: Array<{ label: string; volume: number }> = [];

  if (keepClipAudio) {
    // Build a concatenated clip-audio track matching the visual timeline.
    // For clip segments → take input audio, pad to seg duration in case clip is shorter.
    // For image segments → generate silence (aevalsrc).
    timeline.forEach((seg, i) => {
      if (seg.type === "clip") {
        filterParts.push(
          `[${i}:a]apad,atrim=duration=${seg.durationSeconds.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`,
        );
      } else {
        filterParts.push(
          `aevalsrc=0:d=${seg.durationSeconds.toFixed(4)}:s=44100:c=stereo[a${i}]`,
        );
      }
    });
    const audioConcatInputs = timeline.map((_, i) => `[a${i}]`).join("");
    filterParts.push(`${audioConcatInputs}concat=n=${timeline.length}:v=0:a=1[clip_audio]`);
    audioSources.push({ label: "[clip_audio]", volume: 1.0 });
  }

  if (hasVoiceover) {
    audioSources.push({ label: `[${voiceoverIndex}:a]`, volume: 1.0 });
  }
  if (hasMusicInput) {
    audioSources.push({ label: `[${musicIndex}:a]`, volume: musicVolume });
  }

  let finalAudioLabel: string | null = null;
  if (audioSources.length === 1) {
    filterParts.push(`${audioSources[0].label}volume=${audioSources[0].volume.toFixed(2)}[outa]`);
    finalAudioLabel = "[outa]";
  } else if (audioSources.length > 1) {
    audioSources.forEach((s, i) => {
      filterParts.push(`${s.label}volume=${s.volume.toFixed(2)}[asrc${i}]`);
    });
    const mixInputs = audioSources.map((_, i) => `[asrc${i}]`).join("");
    filterParts.push(`${mixInputs}amix=inputs=${audioSources.length}:duration=longest:dropout_transition=3[outa]`);
    finalAudioLabel = "[outa]";
  }
  // If audioSources.length === 0, no audio mapped (silent output).

  const filterComplex = filterParts.join(";");

  // Passe 1: video + audio assembly
  const finalOut = assPath ? tempPath : outputPath;
  const outputOptions = [
    "-filter_complex", filterComplex,
    "-map", "[outv]",
    ...(finalAudioLabel ? ["-map", finalAudioLabel] : ["-an"]),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    ...(finalAudioLabel ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-shortest",
    "-movflags", "+faststart",
    "-y",
  ];

  command
    .outputOptions(outputOptions)
    .output(finalOut)
    .on("start", (cmd) => console.log(`[FFmpeg] Montage passe 1: ${cmd.slice(0, 300)}...`))
    .on("progress", (info) => onProgress(calcProgress(info.timemark, totalDuration) * (assPath ? 0.6 : 1)))
    .on("end", () => {
      if (assPath) {
        // Passe 2: burn-in ASS subtitles
        console.log(`[FFmpeg] Passe 2 — sous-titres jaunes brûlés (libass)...`);
        ffmpeg(tempPath)
          .outputOptions([
            "-vf", `subtitles=${assPath}`,
            "-c:v", "libx264", "-preset", "fast", "-crf", "22",
            "-pix_fmt", "yuv420p", "-c:a", "copy", "-y",
          ])
          .output(outputPath)
          .on("progress", (info) => onProgress(60 + calcProgress(info.timemark, totalDuration) * 0.4))
          .on("end", async () => {
            try { const { unlink } = await import("fs/promises"); await unlink(tempPath); } catch {}
            finishMontage(outputPath, totalDuration, resolve);
          })
          .on("error", (err) => {
            console.warn(`[FFmpeg] Subtitles burn failed, using passe 1 output: ${err.message}`);
            import("fs").then(fs => { try { fs.renameSync(tempPath, outputPath); } catch {} });
            finishMontage(outputPath, totalDuration, resolve);
          })
          .run();
      } else {
        finishMontage(outputPath, totalDuration, resolve);
      }
    })
    .on("error", (err) => {
      console.error(`[FFmpeg] Montage erreur: ${err.message}`);
      reject(new Error(`FFmpeg montage error: ${err.message}`));
    })
    .run();
}

// -------------------------------------------------------------------
// Fallback: Simple concat demuxer slideshow (no effects)
// -------------------------------------------------------------------
function buildMontageSimple(
  images: Array<{ imagePath: string; sceneIndex: number }>,
  audioPath: string,
  scenes: ScriptScene[],
  outputPath: string,
  totalDuration: number,
  onProgress: (p: number) => void,
  resolve: (r: MontageResult) => void,
  reject: (e: Error) => void,
  concatDir: string,
) {
  const concatFilePath = path.join(concatDir, "concat.txt");
  // Si le provider d'image a échoué sur une scène, son PNG n'existe pas sur le
  // disque. Le démuxeur concat de ffmpeg s'arrête NET à la première référence
  // introuvable → la vidéo est tronquée à cet instant et -shortest rogne la voix
  // d'autant (voix coupée en plein milieu). On substitue toute image manquante
  // par la dernière image valide (ou la première dispo si c'est au tout début) :
  // le créneau temporel de chaque scène est préservé, donc la durée totale et la
  // synchro voix restent intactes.
  const firstGood = images.find((im) => existsSync(im.imagePath))?.imagePath ?? null;
  let lastGood: string | null = null;
  let missing = 0;
  const concatLines: string[] = [];
  images.forEach((img, i) => {
    // Look up the scene by its real index, not the array position: if `images`
    // ever holds a duplicate or skips a scene, positional indexing (`scenes[i]`)
    // would assign the wrong duration to every following image and drift the
    // whole slideshow out of sync with the voiceover.
    const scene = scenes.find((s) => s.index === img.sceneIndex) ?? scenes[i];
    const duration = scene?.durationSeconds || 5;
    let file = img.imagePath;
    if (existsSync(file)) {
      lastGood = file;
    } else {
      missing++;
      file = lastGood ?? firstGood ?? "";
      if (!file) return; // aucune image valide nulle part : on saute le créneau
    }
    concatLines.push(`file '${file}'\nduration ${duration}`);
  });
  if (missing > 0) {
    console.warn(`[FFmpeg] Simple fallback: ${missing} image(s) manquante(s) substituée(s) (sinon concat tronqué + voix coupée)`);
  }
  if (lastGood) {
    concatLines.push(`file '${lastGood}'`);
  }

  writeFile(concatFilePath, concatLines.join("\n")).then(() => {
    const command = ffmpeg()
      .input(concatFilePath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .input(audioPath)
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        "-y",
      ])
      .output(outputPath)
      .on("start", (cmd) => console.log(`[FFmpeg] Simple fallback: ${cmd}`))
      .on("progress", (info) => onProgress(calcProgress(info.timemark, totalDuration)))
      .on("end", () => finishMontage(outputPath, totalDuration, resolve))
      .on("error", (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .run();
  });
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
function calcProgress(timemark: string | undefined, totalDuration: number): number {
  if (!timemark) return 0;
  const parts = timemark.split(":").map(Number);
  const current = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Math.min(100, Math.round((current / totalDuration) * 100));
}

async function finishMontage(
  outputPath: string,
  totalDuration: number,
  resolve: (r: MontageResult) => void,
) {
  console.log(`[FFmpeg] Montage termine: ${outputPath}`);
  const { stat } = await import("fs/promises");
  const stats = await stat(outputPath);
  resolve({ videoPath: outputPath, durationSeconds: totalDuration, fileSize: stats.size });
}

function generateASS(scenes: ScriptScene[]): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,50,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const events: string[] = [];
  let t = 0;
  for (const scene of scenes) {
    const words = scene.narration.split(/\s+/);
    const chunks: string[] = [];
    for (let j = 0; j < words.length; j += 8) chunks.push(words.slice(j, j + 8).join(" "));
    const dur = scene.durationSeconds / (chunks.length || 1);
    chunks.forEach((chunk, j) => {
      events.push(`Dialogue: 0,${formatASSTime(t + j * dur)},${formatASSTime(t + (j + 1) * dur)},Default,,0,0,0,,${chunk}`);
    });
    t += scene.durationSeconds;
  }
  return header + events.join("\n");
}

function formatASSTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function generateSRT(scenes: ScriptScene[]): string {
  const lines: string[] = [];
  let currentTime = 0;

  scenes.forEach((scene) => {
    const words = scene.narration.split(/\s+/);
    const chunkSize = 10;
    const chunks: string[] = [];
    for (let j = 0; j < words.length; j += chunkSize) {
      chunks.push(words.slice(j, j + chunkSize).join(" "));
    }

    const chunkDuration = scene.durationSeconds / (chunks.length || 1);

    chunks.forEach((chunk, j) => {
      const subIndex = lines.filter((l) => /^\d+$/.test(l.trim())).length + 1;
      lines.push(`${subIndex}`);
      lines.push(`${formatSRTTime(currentTime + j * chunkDuration)} --> ${formatSRTTime(currentTime + (j + 1) * chunkDuration)}`);
      lines.push(chunk);
      lines.push("");
    });

    currentTime += scene.durationSeconds;
  });

  return lines.join("\n");
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
