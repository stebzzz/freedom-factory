// Regenerate the project's voiceover from its script via ElevenLabs (eleven_v3,
// native base speed — no atempo), then re-align scene durations to the new audio
// with Whisper so the montage stays in sync. The previous voiceover.wav is
// backed up to voiceover.prev-<ts>.wav.
import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";
import { getConfig } from "@/lib/config";
import { generateVoiceover } from "@/lib/api/voiceover";
import { alignScenesWithWhisper, detectScriptLanguage } from "@/lib/api/whisper";
import type { ScriptScene } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

interface ScriptJson {
  title?: string;
  niche?: string;
  wordCount?: number;
  scenes?: ScriptScene[];
}

/** Transcode any audio (mp3 from ElevenLabs) to a real 44.1k mono PCM wav. */
function transcodeToWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-i", input, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", output,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg wav exit ${code}: ${stderr.slice(-300)}`))));
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  const scriptPath = path.join(project.outDir, "script.json");
  if (!existsSync(scriptPath)) {
    return NextResponse.json({ error: "script.json absent — pas un job pipeline" }, { status: 400 });
  }
  let data: ScriptJson;
  try {
    data = JSON.parse(readFileSync(scriptPath, "utf-8")) as ScriptJson;
  } catch {
    return NextResponse.json({ error: "script.json illisible" }, { status: 500 });
  }
  const scenes = data.scenes ?? [];
  if (scenes.length === 0) return NextResponse.json({ error: "aucune scène dans le script" }, { status: 400 });

  // Optional voice override from the body; default to the configured voice.
  const body = (await req.json().catch(() => ({}))) as { voix?: string; align?: boolean };
  const config = await getConfig();
  const voix = body.voix || config.elevenlabsVoiceId || "male-en";
  const doAlign = body.align !== false;

  // Full spoken text = scene narrations joined (verbatim, no rewriting).
  const fullScript = scenes.map((s) => s.narration?.trim()).filter(Boolean).join("\n\n");
  if (!fullScript) return NextResponse.json({ error: "narrations vides" }, { status: 400 });

  const voPath = path.join(project.outDir, "voiceover.wav");
  const tmpMp3 = path.join(tmpdir(), `regen-vo-${slug}-${Date.now()}.mp3`);

  // 1) Generate via ElevenLabs (voiceover.ts → elevenlabs, default eleven_v3, no atempo).
  try {
    await generateVoiceover(fullScript, voix, tmpMp3, { voiceModel: "elevenlabs" });
  } catch (err) {
    return NextResponse.json({ error: `TTS: ${(err as Error).message}` }, { status: 502 });
  }
  if (!existsSync(tmpMp3)) {
    return NextResponse.json({ error: "TTS n'a produit aucun fichier" }, { status: 502 });
  }

  // 2) Back up the old VO, transcode the new one into voiceover.wav.
  if (existsSync(voPath)) {
    await copyFile(voPath, path.join(project.outDir, `voiceover.prev-${Date.now()}.wav`)).catch(() => {});
  }
  try {
    await transcodeToWav(tmpMp3, voPath);
  } catch (err) {
    await unlink(tmpMp3).catch(() => {});
    return NextResponse.json({ error: `transcodage wav: ${(err as Error).message}` }, { status: 500 });
  }
  await unlink(tmpMp3).catch(() => {});

  // 3) Re-align scene durations on the new audio (keeps the montage in sync).
  let matchPct: number | null = null;
  let totalAudioSec: number | null = null;
  if (doAlign) {
    try {
      const language = detectScriptLanguage(scenes.map((s) => s.narration ?? ""));
      const aligned = await alignScenesWithWhisper(scenes, voPath, { language });
      matchPct = Math.round(aligned.matchedWordRatio * 100);
      totalAudioSec = Math.round(aligned.totalAudioSec * 10) / 10;
      // Persist updated durations (scenes mutated in place).
      writeFileSync(scriptPath, JSON.stringify(
        { title: data.title, niche: data.niche, wordCount: data.wordCount, scenes },
        null, 2,
      ));
    } catch (err) {
      // Non-blocking — the new audio is already in place; durations stay as-is.
      console.warn(`[regen-vo] Whisper align échec: ${(err as Error).message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    model: "eleven_v3",
    voix,
    chars: fullScript.length,
    aligned: matchPct !== null,
    matchPct,
    totalAudioSec,
  });
}
