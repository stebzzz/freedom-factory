// Finalize a pipeline job: assemble images + clips + voiceover + music into output.mp4.
// Used by the "Finaliser" button on pipeline-job pages where the original pipeline run
// failed mid-flow (e.g. voiceover step crashed) and the user provided a manual VO.
import { NextResponse } from "next/server";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";
import { assembleMontage } from "@/lib/api/ffmpeg";
import { alignScenesWithWhisper, detectScriptLanguage } from "@/lib/api/whisper";
import { getPresetOrDefault } from "@/lib/presets/channel-presets";
import type { ScriptScene, AnimationResult } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

// In-flight finalize per slug. The browser fetch may give up at ~60s (Traefik
// default proxy timeout) and the user re-clicks, but ffmpeg keeps running
// server-side. Reject concurrent calls so we don't spawn duplicate ffmpeg
// processes that compete for memory and trigger OOM kills.
declare global {
  // eslint-disable-next-line no-var
  var __finalizeInFlight: Map<string, { startedAt: number }> | undefined;
}
const inFlight: Map<string, { startedAt: number }> =
  globalThis.__finalizeInFlight ?? (globalThis.__finalizeInFlight = new Map());

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const slot = inFlight.get(slug);
  return NextResponse.json({ running: !!slot, startedAt: slot?.startedAt });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  if (inFlight.has(slug)) {
    return NextResponse.json({
      error: "Un montage est déjà en cours sur ce projet — patiente la fin avant de relancer",
      running: true,
    }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const { presetId, subtitles, alignWithWhisper } = body as {
    presetId?: string;
    subtitles?: boolean;
    alignWithWhisper?: boolean;
  };

  const jobDir = project.outDir;
  const scriptJsonPath = path.join(jobDir, "script.json");
  if (!existsSync(scriptJsonPath)) {
    return NextResponse.json({ error: "script.json absent — projet incompatible avec le finalize pipeline" }, { status: 400 });
  }

  const voiceoverPath = path.join(jobDir, "voiceover.wav");
  if (!existsSync(voiceoverPath)) {
    return NextResponse.json({ error: "voiceover.wav absent — uploade un fichier audio d'abord" }, { status: 400 });
  }

  let scenes: ScriptScene[];
  try {
    const scriptData = JSON.parse(await readFile(scriptJsonPath, "utf-8")) as { scenes: ScriptScene[] };
    scenes = scriptData.scenes;
  } catch (e) {
    return NextResponse.json({ error: `script.json illisible: ${(e as Error).message}` }, { status: 500 });
  }
  if (!scenes?.length) {
    return NextResponse.json({ error: "script.json sans scènes" }, { status: 400 });
  }

  // Collect clips (if any) and images on disk. assembleMontage accepts either,
  // and falls back to Ken Burns on still images when no clip is present.
  const clipsDir = path.join(jobDir, "clips");
  const imagesDir = path.join(jobDir, "images");

  const clipFiles = existsSync(clipsDir)
    ? (await readdir(clipsDir)).filter((f) => /\.(mp4|webm|mov)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  const clips: AnimationResult[] = clipFiles.flatMap((f): AnimationResult[] => {
    const m = f.match(/clip_(\d+)/);
    if (!m) return [];
    const sceneIndex = parseInt(m[1], 10);
    const clipPath = path.join(clipsDir, f);
    const sizeOk = statSync(clipPath).size > 1024 * 50;
    return [{
      sceneIndex,
      clipPath,
      durationSeconds: scenes.find((s) => s.index === sceneIndex)?.durationSeconds ?? 5,
      isMock: !sizeOk,
    }];
  });

  const imageFiles = existsSync(imagesDir)
    ? (await readdir(imagesDir)).filter((f) => /^scene_\d+\.(png|jpe?g|webp)$/i.test(f))
    : [];
  // A scene regenerated under a different extension (e.g. scene_000.jpg later
  // re-rendered as scene_000.png) leaves BOTH files on disk. Globbing both would
  // feed two entries for the same sceneIndex into the montage; the simple concat
  // fallback indexes durations positionally, so the duplicates shift every later
  // scene out of sync with the voiceover. Keep one file per scene — the newest.
  const bySceneIndex = new Map<number, { imagePath: string; sceneIndex: number; mtime: number }>();
  for (const f of imageFiles) {
    const m = f.match(/scene_(\d+)/);
    if (!m) continue;
    const sceneIndex = parseInt(m[1], 10);
    const imagePath = path.join(imagesDir, f);
    const mtime = statSync(imagePath).mtimeMs;
    const prev = bySceneIndex.get(sceneIndex);
    if (!prev || mtime > prev.mtime) bySceneIndex.set(sceneIndex, { imagePath, sceneIndex, mtime });
  }
  const images = [...bySceneIndex.values()]
    .map(({ imagePath, sceneIndex }) => ({ imagePath, sceneIndex }))
    .sort((a, b) => a.sceneIndex - b.sceneIndex);

  if (clips.length === 0 && images.length === 0) {
    return NextResponse.json({ error: "aucun clip ni image trouvé dans le job — rien à monter" }, { status: 400 });
  }

  const musicPath = path.join(jobDir, "music.wav");
  const hasMusic = existsSync(musicPath);
  const preset = getPresetOrDefault(presetId);
  const outputPath = path.join(jobDir, "master.mp4");

  console.log(`[Finalize ${slug}] ${clips.length} clips + ${images.length} images, music=${hasMusic}, preset=${preset.id}`);

  inFlight.set(slug, { startedAt: Date.now() });
  try {
    // CRITICAL: a manually-uploaded voiceover doesn't follow the scene durations
    // baked into script.json (those were Claude's theoretical 1.5s/scene splits).
    // Run whisper to transcribe the real audio and snap each scene's
    // durationSeconds to its actual word window — otherwise the montage drifts
    // out of sync with the voice (which is exactly what the user reported).
    if (alignWithWhisper !== false) {
      try {
        // Don't trust preset.language — a user can pick a French preset for an English
        // script. Detect from the narrations themselves so OpenAI Whisper transcribes
        // the audio in the right language (otherwise it force-translates and the
        // word match crashes to 0%).
        const detectedLang = detectScriptLanguage(scenes.map((s) => s.narration ?? ""));
        console.log(`[Finalize ${slug}] aligning ${scenes.length} scenes via Whisper (lang=${detectedLang}, preset=${preset.language})...`);
        const aligned = await alignScenesWithWhisper(scenes, voiceoverPath, {
          language: detectedLang,
        });
        // Persist the new durations back into script.json so downstream consumers
        // (and future finalizes) see the aligned timeline.
        const meta = JSON.parse(await readFile(scriptJsonPath, "utf-8"));
        meta.scenes = scenes;
        await writeFile(scriptJsonPath, JSON.stringify(meta, null, 2));
        const matchPct = Math.round(aligned.matchedWordRatio * 100);
        console.log(`[Finalize ${slug}] Whisper aligned: ${aligned.totalAudioSec.toFixed(1)}s audio, ${matchPct}% word match`);
      } catch (err) {
        console.warn(`[Finalize ${slug}] Whisper alignment failed (${(err as Error).message}) — using script.json durations`);
      }
    }

    const result = await assembleMontage(
      {
        audioPath: voiceoverPath,
        musicPath: hasMusic ? musicPath : undefined,
        images,
        clips,
        scenes,
        outputPath,
        kenBurns: true,
        kenBurnsSpeed: preset.visual.kenBurnsSpeed,
        transitionType: preset.visual.transitionType,
        transitionDuration: preset.visual.transitionDuration,
        musicVolume: preset.audio.musicVolume,
        subtitlesEnabled: subtitles !== false,
      },
      (pct) => console.log(`[Finalize ${slug}] encoding ${pct}%`),
    );

    return NextResponse.json({
      ok: true,
      videoPath: result.videoPath,
      videoUrl: `/generated/${slug}/master.mp4`,
      durationSeconds: result.durationSeconds,
      fileSize: result.fileSize,
    });
  } catch (err) {
    console.error(`[Finalize ${slug}]`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  } finally {
    inFlight.delete(slug);
  }
}
