import { writeFile } from "fs/promises";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

// GenAIPro Labs TTS (ElevenLabs-backed) — async task + polling.
//   POST /v1/labs/task          → { task_id }
//   GET  /v1/labs/task/{id}     → { status, result (mp3 url) }
// Auth: Authorization: Bearer <genaiproKey>. Same key as the Veo image/video endpoints.

const API_BASE = "https://genaipro.io/api";
const POLL_INTERVAL_MS = 4_000;
const POLL_TIMEOUT_MS = 40 * 60 * 1000; // 40 min — long scripts (>5k chars) can take 10-15min côté GenAIPro
const STATUS_LOG_INTERVAL_MS = 30_000; // log status every 30s so silent polling is visible

// Same preset map as elevenlabs.ts — Labs accepts the ElevenLabs voice IDs verbatim.
const DEFAULT_VOICE_MAP: Record<string, string> = {
  "male-fr":   "pNInz6obpgDQGcFmaJgB", // Adam
  "female-fr": "21m00Tcm4TlvDq8ikWAM", // Rachel
  "male-en":   "ErXwobaYiN019PkySvjV", // Antoni
  "female-en": "EXAVITQu4vr4xnSDxMaL", // Bella
};

export type GenaiproTTSModel =
  | "eleven_multilingual_v2"
  | "eleven_turbo_v2_5"
  | "eleven_flash_v2_5"
  | "eleven_v3";

const DEFAULT_MODEL: GenaiproTTSModel = "eleven_multilingual_v2";

interface CreateTaskResponse {
  task_id?: string;
  message?: string;
  error?: string;
}

interface GetTaskResponse {
  id?: string;
  status?: "pending" | "processing" | "completed" | "failed" | string;
  result?: string;
  message?: string;
  error?: string;
}

async function loadToken(): Promise<string> {
  const config = await getConfig();
  const k = process.env.GENAIPRO_API_KEY
    || process.env.GENAIPRO_TOKEN
    || (config as unknown as { genaiproKey?: string }).genaiproKey
    || "";
  if (!k) throw new Error("GENAIPRO_API_KEY manquante (env ou config) — requise pour voiceModel=genaipro");
  return k;
}

async function createTask(
  token: string,
  input: string,
  voiceId: string,
  model: GenaiproTTSModel,
  speed: number,
): Promise<string> {
  const res = await fetch(`${API_BASE}/v1/labs/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      input,
      voice_id: voiceId,
      model_id: model,
      stability: 0.5,
      similarity: 0.75,
      style: 0.3,
      speed,
      use_speaker_boost: true,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as CreateTaskResponse;
  if (!res.ok || !data.task_id) {
    throw new Error(`GenAIPro TTS create failed ${res.status}: ${data.error ?? data.message ?? "no task_id"}`);
  }
  return data.task_id;
}

async function pollTask(token: string, taskId: string): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_MS;
  let lastLoggedAt = 0;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${API_BASE}/v1/labs/task/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as GetTaskResponse;
    if (data.status === "completed") {
      if (!data.result) throw new Error(`GenAIPro TTS ${taskId}: completed but no result url`);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[GenAIPro-TTS] ${taskId.slice(0, 8)}… completed after ${elapsed}s`);
      return data.result;
    }
    if (data.status === "failed") {
      throw new Error(`GenAIPro TTS ${taskId} failed: ${data.error ?? data.message ?? "unknown"}`);
    }
    // pending / processing → keep polling, but emit a status log every 30s so the silent wait is visible
    const now = Date.now();
    if (now - lastLoggedAt >= STATUS_LOG_INTERVAL_MS || data.status !== lastStatus) {
      const elapsed = Math.round((now - startedAt) / 1000);
      console.log(`[GenAIPro-TTS] ${taskId.slice(0, 8)}… status=${data.status ?? "?"} (elapsed ${elapsed}s)`);
      lastLoggedAt = now;
      lastStatus = data.status;
    }
  }
  throw new Error(`GenAIPro TTS ${taskId} timeout after ${POLL_TIMEOUT_MS / 1000}s`);
}

export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
  options: { model?: GenaiproTTSModel; speed?: number } = {},
): Promise<VoiceoverResult> {
  let token: string;
  try {
    token = await loadToken();
  } catch (err) {
    console.warn(`[GenAIPro-TTS] no API key → fallback mock: ${(err as Error).message}`);
    return generateMockAudio(script, outputPath);
  }

  // Voice ID resolution priority: raw ID (16-32 alphanumeric) → preset map → fallback fr male.
  const looksLikeVoiceId = /^[A-Za-z0-9]{16,32}$/.test(voix);
  const voiceId = looksLikeVoiceId
    ? voix
    : DEFAULT_VOICE_MAP[voix] || DEFAULT_VOICE_MAP["male-fr"];

  const model = options.model ?? DEFAULT_MODEL;
  // GenAIPro Labs hard-limits speed to [0.7, 1.2] (same as ElevenLabs upstream). Clamp here so atempo carries the rest.
  const speed = Math.max(0.7, Math.min(1.2, options.speed ?? 1));

  console.log(`[GenAIPro-TTS] task submit (voice=${voiceId.slice(0, 8)}…, model=${model}, speed=${speed}, ${script.length} chars)`);
  const taskId = await createTask(token, script, voiceId, model, speed);
  const mp3Url = await pollTask(token, taskId);

  const res = await fetch(mp3Url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GenAIPro TTS download ${res.status}: ${mp3Url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buf);

  // Whisper alignment downstream will replace this estimate with the real duration.
  const durationSeconds = Math.round(script.split(/\s+/).length / 2.5);
  console.log(`[GenAIPro-TTS] OK → ${outputPath} (~${durationSeconds}s, ${(buf.length / 1024).toFixed(0)} KB)`);
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
  console.log(`[GenAIPro-TTS] Mock WAV → ${outputPath} (${durationSeconds}s silence)`);
  return { audioPath: outputPath, durationSeconds };
}
