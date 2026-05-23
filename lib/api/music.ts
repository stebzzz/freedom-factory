import { writeFile } from "fs/promises";
import { MusicResult } from "@/lib/pipeline/types";

// Background music generation (Suno API - when public API becomes available)
// For now: mock generates silence, real mode expects SUNO_API_KEY or MUBERT_API_KEY
const MOCK_MODE = !process.env.SUNO_API_KEY && !process.env.MUBERT_API_KEY;

export async function generateMusic(
  title: string,
  niche: string,
  durationSeconds: number,
  outputPath: string,
): Promise<MusicResult> {
  if (MOCK_MODE) {
    console.log("[Music] Mode mock - generation musique silence");
    return generateMockMusic(durationSeconds, outputPath);
  }

  // Mubert API (when MUBERT_API_KEY is set)
  if (process.env.MUBERT_API_KEY) {
    return generateMubert(title, niche, durationSeconds, outputPath);
  }

  // Suno API placeholder (when public API is available)
  if (process.env.SUNO_API_KEY) {
    return generateSuno(title, niche, durationSeconds, outputPath);
  }

  return generateMockMusic(durationSeconds, outputPath);
}

async function generateSuno(
  title: string,
  niche: string,
  durationSeconds: number,
  outputPath: string,
): Promise<MusicResult> {
  // Suno API - uncomment when public API is available
  // const prompt = buildMusicPrompt(title, niche);
  // POST https://api.suno.ai/v1/generate with { prompt, duration }
  console.log("[Suno] API not yet public - falling back to mock");
  return generateMockMusic(durationSeconds, outputPath);
}

async function generateMubert(
  title: string,
  niche: string,
  durationSeconds: number,
  outputPath: string,
): Promise<MusicResult> {
  const genre = NICHE_TO_GENRE[niche] || "cinematic";
  const response = await fetch("https://api.mubert.com/v2/TTMRecordTrack", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.MUBERT_API_KEY}`,
    },
    body: JSON.stringify({
      method: "RecordTrack",
      params: {
        pat: process.env.MUBERT_API_KEY,
        tags: genre,
        duration: durationSeconds,
        format: "mp3",
        intensity: "medium",
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[Mubert] Erreur: ${err}`);
    return generateMockMusic(durationSeconds, outputPath);
  }

  const data = await response.json();
  const trackUrl = data?.data?.tasks?.[0]?.download_link;
  if (!trackUrl) return generateMockMusic(durationSeconds, outputPath);

  const audioResponse = await fetch(trackUrl);
  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  await writeFile(outputPath, buffer);

  console.log(`[Mubert] Musique generee : ${outputPath}`);
  return { audioPath: outputPath, durationSeconds, genre };
}

async function generateMockMusic(durationSeconds: number, outputPath: string): Promise<MusicResult> {
  // Generate a silent WAV placeholder
  const sampleRate = 44100;
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * 2;
  const fileSize = 44 + dataSize;

  const buffer = Buffer.alloc(fileSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  const wavPath = outputPath.replace(/\.(mp3|wav)$/, ".wav");
  await writeFile(wavPath, buffer);
  console.log(`[Music] Mock musique WAV : ${wavPath} (${durationSeconds}s silence)`);
  return { audioPath: wavPath, durationSeconds, genre: "ambient" };
}

function buildMusicPrompt(title: string, niche: string): string {
  const genre = NICHE_TO_GENRE[niche] || "cinematic";
  return `${genre} background music for a YouTube video about ${title}, no vocals, inspiring, ${durationPrompt(genre)}`;
}

function durationPrompt(genre: string): string {
  const styles: Record<string, string> = {
    cinematic: "orchestral, epic",
    tech: "electronic, modern, ambient",
    mystery: "dark ambient, suspenseful",
    history: "classical, dramatic",
    finance: "corporate, uplifting",
  };
  return styles[genre] || "ambient, atmospheric";
}

const NICHE_TO_GENRE: Record<string, string> = {
  "Mysteres & Faits":  "mystery",
  "Tech & Science":    "tech",
  "Dev. personnel":    "inspirational",
  "Voyage & Culture":  "world",
  "Histoire":          "history",
  "Finance":           "finance",
  "Sante & Bien-etre": "wellness",
  "Gaming":            "electronic",
};
