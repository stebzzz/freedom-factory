import { writeFile } from "fs/promises";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

const API_BASE = "https://api.elevenlabs.io/v1";

const DEFAULT_VOICE_MAP: Record<string, string> = {
  "male-fr":   "pNInz6obpgDQGcFmaJgB", // Adam
  "female-fr": "21m00Tcm4TlvDq8ikWAM", // Rachel
  "male-en":   "ErXwobaYiN019PkySvjV", // Antoni
  "female-en": "EXAVITQu4vr4xnSDxMaL", // Bella
};

export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
  options: { speed?: number } = {},
): Promise<VoiceoverResult> {
  const config = await getConfig();
  const apiKey = config.elevenlabsKey;

  if (!apiKey) {
    console.log("[ElevenLabs] Mode mock - pas de cle API");
    return generateMockAudio(script, outputPath);
  }

  // Priority: explicit raw voice ID in `voix` (looks like an ElevenLabs ID) → preset map → config default → fallback.
  const looksLikeVoiceId = /^[A-Za-z0-9]{16,32}$/.test(voix);
  const voiceId = looksLikeVoiceId
    ? voix
    : DEFAULT_VOICE_MAP[voix] || config.elevenlabsVoiceId || DEFAULT_VOICE_MAP["male-fr"];

  const speed = Math.max(0.7, Math.min(1.2, options.speed ?? 1));

  const response = await fetch(`${API_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text: script,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        speed,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 401 || response.status === 403) {
      console.warn(`[ElevenLabs] Cle API invalide (${response.status}) — fallback mock. Verifie la cle dans /settings.`);
      return generateMockAudio(script, outputPath);
    }
    throw new Error(`ElevenLabs API error: ${response.status} - ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);

  const durationSeconds = Math.round(script.split(/\s+/).length / 2.5);
  console.log(`[ElevenLabs] Audio genere : ${outputPath} (~${durationSeconds}s)`);

  return { audioPath: outputPath, durationSeconds };
}

async function generateMockAudio(script: string, outputPath: string): Promise<VoiceoverResult> {
  const wordCount = script.split(/\s+/).length;
  const durationSeconds = Math.round(wordCount / 2.5);

  // Generate a silent WAV file as placeholder
  const sampleRate = 44100;
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * 2; // 16-bit mono
  const fileSize = 44 + dataSize;

  const buffer = Buffer.alloc(fileSize);
  // WAV header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // data is already zeroed (silence)

  await writeFile(outputPath, buffer);
  console.log(`[ElevenLabs] Mock audio WAV : ${outputPath} (${durationSeconds}s silence)`);

  return { audioPath: outputPath, durationSeconds };
}
