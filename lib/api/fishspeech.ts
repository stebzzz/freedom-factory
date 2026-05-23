import { writeFile } from "fs/promises";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

const API_BASE = "https://api.siliconflow.cn/v1/audio/speech";

// Fish Speech 1.5 via SiliconFlow
// Voices: reference audio can be used, or built-in voice seeds
const VOICE_MAP: Record<string, string> = {
  "male-fr":   "male-boreal-fr",    // FR masculin narratif
  "female-fr": "female-boreal-fr",  // FR feminin informatif
  "male-en":   "male-boreal-en",    // EN masculine cinematic
  "female-en": "female-boreal-en",  // EN feminine storytelling
};

export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
): Promise<VoiceoverResult> {
  const config = await getConfig();
  const apiKey = config.siliconflowKey;

  if (!apiKey) {
    console.log("[FishSpeech] Mode mock - pas de cle SiliconFlow");
    return generateMockAudio(script, outputPath);
  }

  const voice = VOICE_MAP[voix] || VOICE_MAP["male-fr"];

  const response = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "FunAudioLLM/FishSpeech-1.5",
      input: script,
      voice,
      response_format: "mp3",
      speed: 1.0,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 401 || response.status === 403) {
      console.warn(`[FishSpeech] Cle API invalide (${response.status}) — fallback mock. Verifie la cle dans /settings.`);
      return generateMockAudio(script, outputPath);
    }
    throw new Error(`Fish Speech API error: ${response.status} - ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  // Output path uses .mp3 with Fish Speech
  const mp3Path = outputPath.replace(/\.(wav|mp3)$/, ".mp3");
  await writeFile(mp3Path, buffer);

  const durationSeconds = Math.round(script.split(/\s+/).length / 2.5);
  console.log(`[FishSpeech] Audio genere : ${mp3Path} (~${durationSeconds}s)`);
  return { audioPath: mp3Path, durationSeconds };
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
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  const wavPath = outputPath.replace(/\.mp3$/, ".wav");
  await writeFile(wavPath, buffer);
  console.log(`[FishSpeech] Mock audio WAV : ${wavPath} (${durationSeconds}s silence)`);
  return { audioPath: wavPath, durationSeconds };
}
