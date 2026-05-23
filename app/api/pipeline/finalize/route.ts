import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import path from "path";
import { assembleMontage } from "@/lib/api/ffmpeg";
import { getPresetOrDefault } from "@/lib/presets/channel-presets";
import type { ScriptScene, AnimationResult } from "@/lib/pipeline/types";

// Run montage on an existing job dir.
// Body: { jobDir: string, presetId?: string, subtitles?: boolean }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { jobDir?: string; presetId?: string; subtitles?: boolean };
    const jobDir = body.jobDir;
    if (!jobDir || !existsSync(jobDir)) {
      return NextResponse.json({ error: `jobDir invalide: ${jobDir}` }, { status: 400 });
    }

    const scriptJsonPath = path.join(jobDir, "script.json");
    if (!existsSync(scriptJsonPath)) {
      return NextResponse.json({ error: `script.json absent dans ${jobDir}` }, { status: 400 });
    }
    const scriptData = JSON.parse(await readFile(scriptJsonPath, "utf-8")) as { scenes: ScriptScene[] };
    const scenes = scriptData.scenes;

    const voiceoverPath = path.join(jobDir, "voiceover.wav");
    if (!existsSync(voiceoverPath)) {
      return NextResponse.json({ error: `voiceover.wav absent` }, { status: 400 });
    }

    const musicPath = path.join(jobDir, "music.wav");
    const hasMusic = existsSync(musicPath);

    const clipsDir = path.join(jobDir, "clips");
    const clipFiles = existsSync(clipsDir)
      ? (await readdir(clipsDir)).filter((f) => f.endsWith(".mp4")).sort()
      : [];
    const clips: AnimationResult[] = clipFiles.map((f) => {
      const m = f.match(/clip_(\d+)/);
      const sceneIndex = m ? parseInt(m[1], 10) : 0;
      const clipPath = path.join(clipsDir, f);
      const sizeOk = statSync(clipPath).size > 1024 * 50;
      return {
        sceneIndex,
        clipPath,
        durationSeconds: scenes.find((s) => s.index === sceneIndex)?.durationSeconds ?? 5,
        isMock: !sizeOk,
      };
    });

    const preset = getPresetOrDefault(body.presetId);
    const outputPath = path.join(jobDir, "output.mp4");

    console.log(`[Finalize] ${jobDir} — ${clips.length} clips, music=${hasMusic}, preset=${preset.id}`);

    const result = await assembleMontage(
      {
        audioPath: voiceoverPath,
        musicPath: hasMusic ? musicPath : undefined,
        images: [],
        clips,
        scenes,
        outputPath,
        kenBurns: true,
        kenBurnsSpeed: preset.visual.kenBurnsSpeed,
        transitionType: preset.visual.transitionType,
        transitionDuration: preset.visual.transitionDuration,
        musicVolume: preset.audio.musicVolume,
        subtitlesEnabled: body.subtitles !== false,
      },
      (pct) => console.log(`[Finalize] encoding ${pct}%`),
    );

    return NextResponse.json({
      ok: true,
      videoPath: result.videoPath,
      durationSeconds: result.durationSeconds,
      fileSize: result.fileSize,
    });
  } catch (err) {
    console.error("[API /pipeline/finalize]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
