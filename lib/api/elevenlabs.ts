import { writeFile, unlink, mkdtemp, readdir, rename } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { spawn } from "child_process";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

const API_BASE = "https://api.elevenlabs.io/v1";

// Default TTS model. Eleven v3 is the most expressive model; its pacing is good
// natively so we do NOT atempo-stretch v3 output (we keep the raw base speed).
// Overridable per-call via options.model or the ELEVENLABS_MODEL env var.
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL || "eleven_v3";

// ElevenLabs caps /v1/text-to-speech at ~5000 chars per call on standard plans.
// We chunk at sentence boundaries with a generous safety margin.
const MAX_CHARS_PER_CHUNK = 4500;

const DEFAULT_VOICE_MAP: Record<string, string> = {
  "male-fr":   "pNInz6obpgDQGcFmaJgB", // Adam
  "female-fr": "21m00Tcm4TlvDq8ikWAM", // Rachel
  "male-en":   "ErXwobaYiN019PkySvjV", // Antoni
  "female-en": "EXAVITQu4vr4xnSDxMaL", // Bella
};

/** Split text at sentence boundaries so each chunk stays under MAX_CHARS_PER_CHUNK. */
function chunkScript(text: string, max = MAX_CHARS_PER_CHUNK): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]?[\n]?/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > max && cur) { chunks.push(cur.trim()); cur = ""; }
    if (s.length > max) {
      // A single sentence longer than the cap (rare). Hard-split on whitespace.
      const words = s.split(/\s+/);
      let buf = "";
      for (const w of words) {
        if (buf.length + w.length + 1 > max) { chunks.push(buf.trim()); buf = ""; }
        buf += (buf ? " " : "") + w;
      }
      if (buf) cur += (cur ? " " : "") + buf;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => c.length > 0);
}

async function ttsOneChunk(
  text: string,
  voiceId: string,
  apiKey: string,
  speed: number,
  model: string,
): Promise<Buffer> {
  const isV3 = /eleven_v3|^v3$/i.test(model);
  // v3 expects a leaner voice_settings (no `style`/`speed`); other models keep
  // the expressive style + a speed nudge.
  const voice_settings = isV3
    ? { stability: 0.5, similarity_boost: 0.75 }
    : { stability: 0.5, similarity_boost: 0.75, style: 0.3, speed: Math.max(0.7, Math.min(1.2, speed)) };
  const res = await fetch(`${API_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: isV3 ? "eleven_v3" : model,
      voice_settings,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err: Error & { status?: number } = new Error(
      `ElevenLabs ${res.status}: ${errText.slice(0, 400)}`,
    );
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Time-stretch an audio file in place via ffmpeg `atempo` (pitch-preserving).
 * Implemented locally to avoid importing from voiceover.ts — that module
 * dynamically imports THIS one, and a static back-import created a circular
 * dependency that left the imported function undefined at runtime, silently
 * skipping the speed-up (the bug that made voiceSpeed feel ignored).
 */
async function applyAtempo(filePath: string, factor: number): Promise<void> {
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.01) return;
  // atempo is valid in [0.5, 2.0] per stage; our voiceSpeed range (0.7–1.2)
  // always fits in a single stage.
  const clamped = Math.max(0.5, Math.min(2.0, factor));
  const tmpOut = `${filePath}.atempo.mp3`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-i", filePath, "-filter:a", `atempo=${clamped}`, "-c:a", "libmp3lame", "-q:a", "2", tmpOut,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => reject(new Error(`ffmpeg atempo spawn: ${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`atempo exit ${code}: ${stderr.slice(-300)}`))));
  });
  await rename(tmpOut, filePath);
}

/** Concatenate mp3 chunks losslessly via ffmpeg concat demuxer. */
async function concatMp3Chunks(chunkPaths: string[], outputPath: string): Promise<void> {
  const listPath = `${outputPath}.concat.txt`;
  const lines = chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, lines + "\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)));
    child.on("exit", (code) => {
      unlink(listPath).catch(() => {});
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg concat exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
  options: { speed?: number; model?: string } = {},
): Promise<VoiceoverResult> {
  const config = await getConfig();
  const apiKey = config.elevenlabsKey;

  if (!apiKey) {
    console.log("[ElevenLabs] Mode mock — pas de cle API");
    return generateMockAudio(script, outputPath);
  }

  // Priority: explicit raw voice ID in `voix` → preset map → config default → fallback.
  const looksLikeVoiceId = /^[A-Za-z0-9]{16,32}$/.test(voix);
  const voiceId = looksLikeVoiceId
    ? voix
    : DEFAULT_VOICE_MAP[voix] || config.elevenlabsVoiceId || DEFAULT_VOICE_MAP["male-fr"];

  const model = options.model || DEFAULT_MODEL;
  const isV3 = /eleven_v3|^v3$/i.test(model);
  const chunks = chunkScript(script);
  const speed = Math.max(0.7, Math.min(1.2, options.speed ?? 1));
  console.log(`[ElevenLabs] TTS — model=${model}, voice=${voiceId.slice(0, 8)}…, ${script.length} chars in ${chunks.length} chunk(s)${isV3 ? " (v3: base speed, no atempo)" : `, speed=${speed}`}`);

  try {
    if (chunks.length === 1) {
      const buf = await ttsOneChunk(chunks[0], voiceId, apiKey, speed, model);
      await writeFile(outputPath, buf);
    } else {
      // Multiple chunks — write each as a temp mp3 then concat losslessly.
      const tmp = await mkdtemp(path.join(tmpdir(), "el-"));
      const partPaths: string[] = [];
      try {
        for (let i = 0; i < chunks.length; i++) {
          const buf = await ttsOneChunk(chunks[i], voiceId, apiKey, speed, model);
          const p = path.join(tmp, `part-${String(i).padStart(3, "0")}.mp3`);
          await writeFile(p, buf);
          partPaths.push(p);
          console.log(`[ElevenLabs] chunk ${i + 1}/${chunks.length} — ${chunks[i].length} chars → ${buf.length} bytes`);
        }
        await concatMp3Chunks(partPaths, outputPath);
      } finally {
        for (const f of await readdir(tmp).catch(() => [] as string[])) {
          await unlink(path.join(tmp, f)).catch(() => {});
        }
      }
    }
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 401 || e.status === 403) {
      console.warn(`[ElevenLabs] Cle API invalide (${e.status}) — fallback mock. Verifie la cle dans /settings.`);
      return generateMockAudio(script, outputPath);
    }
    if (e.status === 429) {
      console.warn(`[ElevenLabs] Quota dépassé (429) — fallback mock.`);
      return generateMockAudio(script, outputPath);
    }
    throw err;
  }

  // Pacing: atempo time-stretch for models whose native speed is near-inert
  // (e.g. multilingual_v2). v3 keeps its natural base speed — no atempo.
  const effectiveSpeed = isV3 ? 1 : speed;
  if (!isV3 && Math.abs(speed - 1) > 0.01) {
    try {
      await applyAtempo(outputPath, speed);
    } catch (err) {
      console.warn(`[ElevenLabs] atempo ×${speed} échoué (${(err as Error).message}) — audio à vitesse native`);
    }
  }

  const durationSeconds = Math.round((script.split(/\s+/).length / 2.5) / effectiveSpeed);
  console.log(`[ElevenLabs] Audio genere : ${outputPath} (~${durationSeconds}s)`);
  return { audioPath: outputPath, durationSeconds };
}

async function generateMockAudio(script: string, outputPath: string): Promise<VoiceoverResult> {
  const wordCount = script.split(/\s+/).length;
  const durationSeconds = Math.round(wordCount / 2.5);
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
  await writeFile(outputPath, buffer);
  console.log(`[ElevenLabs] Mock audio WAV : ${outputPath} (${durationSeconds}s silence)`);
  return { audioPath: outputPath, durationSeconds };
}
