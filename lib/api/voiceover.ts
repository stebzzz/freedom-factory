import { spawn } from "child_process";
import { rename, unlink } from "fs/promises";
import path from "path";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig, AppSettings } from "@/lib/config";
import type { GenaiproTTSModel } from "./genaipro-tts";

export interface VoiceoverOptions {
  /** Per-call override for the voice backend. Falls back to config.voiceModel. */
  voiceModel?: AppSettings["voiceModel"];
  /** GenAIPro Labs model override (only used when the resolved backend is "genaipro"). */
  genaiproTTSModel?: GenaiproTTSModel;
  /** TTS-native speed (GenAIPro/ElevenLabs only). Hard limit [0.7, 1.2]. */
  voiceSpeed?: number;
}

// Unified voiceover module — delegates to GenAIPro Labs, ElevenLabs, or Fish Speech.
// Per-job `options.voiceModel` wins over the global config.voiceModel.
export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
  options: VoiceoverOptions = {},
): Promise<VoiceoverResult> {
  const config = await getConfig();
  const backend = options.voiceModel ?? config.voiceModel;
  const speed = options.voiceSpeed;

  if (backend === "elevenlabs") {
    const { generateVoiceover: elevenlabsTTS } = await import("./elevenlabs");
    return elevenlabsTTS(script, voix, outputPath, { speed });
  }

  if (backend === "fishspeech") {
    if (speed !== undefined && Math.abs(speed - 1) > 0.01) {
      console.warn(`[Voiceover] Fish Speech ne supporte pas le param speed (demandé ${speed}) — utilise audioSpeed (atempo) à la place.`);
    }
    const { generateVoiceover: fishSpeechTTS } = await import("./fishspeech");
    return fishSpeechTTS(script, voix, outputPath);
  }

  // Default: GenAIPro Labs TTS (ElevenLabs models hosted by GenAIPro, single API key).
  const { generateVoiceover: genaiproTTS } = await import("./genaipro-tts");
  return genaiproTTS(script, voix, outputPath, { model: options.genaiproTTSModel, speed });
}

/**
 * Time-stretch the audio file in-place using ffmpeg's `atempo` filter.
 * `atempo` preserves pitch and is valid for factors in [0.5, 100.0] (recent ffmpeg),
 * but artifacts grow noticeably outside [0.7, 1.5]. For huge factors we chain multiple
 * atempo stages so each stays inside its sweet spot.
 *
 * Returns the new probed duration (seconds) after the stretch.
 */
export async function applyAudioSpeed(audioPath: string, factor: number): Promise<number> {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.01) {
    return await probeDuration(audioPath);
  }
  const clamped = Math.max(0.5, Math.min(2.0, factor));
  // Chain atempo stages when factor goes outside [0.5, 2.0]. We clamp above so this is
  // typically a single-stage call; the loop keeps the helper future-proof for wider sliders.
  const stages: number[] = [];
  let remaining = clamped;
  while (remaining > 2.0) { stages.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5) { stages.push(0.5); remaining /= 0.5; }
  stages.push(remaining);
  const filter = stages.map((s) => `atempo=${s.toFixed(4)}`).join(",");

  const tmpPath = `${audioPath}.atempo${path.extname(audioPath) || ".wav"}`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", audioPath,
      "-filter:a", filter,
      "-vn", tmpPath,
    ]);
    let err = "";
    proc.stderr.on("data", (c) => { err += c.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg atempo exit ${code}: ${err.slice(-400)}`)));
  });

  await unlink(audioPath).catch(() => {});
  await rename(tmpPath, audioPath);
  const dur = await probeDuration(audioPath);
  console.log(`[Voiceover] atempo×${clamped.toFixed(2)} → ${audioPath} (${dur.toFixed(2)}s)`);
  return dur;
}

// Supprime les blancs de la voix off : coupe le silence de tête + resserre les
// pauses internes/de fin plus longues que ~0.6s en gardant ~0.25s de respiration.
// Retourne la nouvelle durée (secondes). À lancer AVANT l'alignement Whisper.
export async function removeSilences(audioPath: string): Promise<number> {
  const tmpPath = `${audioPath}.desilence${path.extname(audioPath) || ".wav"}`;
  const filter =
    "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-38dB:" +
    "stop_periods=-1:stop_duration=0.6:stop_threshold=-38dB:stop_silence=0.25";
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", audioPath,
      "-filter:a", filter,
      "-vn", tmpPath,
    ]);
    let err = "";
    proc.stderr.on("data", (c) => { err += c.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg silenceremove exit ${code}: ${err.slice(-400)}`)));
  });
  await unlink(audioPath).catch(() => {});
  await rename(tmpPath, audioPath);
  const dur = await probeDuration(audioPath);
  console.log(`[Voiceover] silences retirés → ${audioPath} (${dur.toFixed(2)}s)`);
  return dur;
}

async function probeDuration(audioPath: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    let out = "", err = "";
    proc.stdout.on("data", (c) => { out += c.toString(); });
    proc.stderr.on("data", (c) => { err += c.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => code === 0
      ? resolve(parseFloat(out.trim()) || 0)
      : reject(new Error(`ffprobe exit ${code}: ${err.slice(-200)}`)));
  });
}
