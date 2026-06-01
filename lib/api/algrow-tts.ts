import { writeFile } from "fs/promises";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

// Algrow TTS (ElevenLabs/Stealth-backed) — async job + polling.
//   POST /api/generate-simple   (multipart form-data) → { job_id }
//   GET  /api/job-status/:job_id                      → { status, audio_url }
// Auth: Authorization: Bearer <algrowKey>.
// Output is an MP3 hosted on the Algrow CDN; we download it to outputPath.

const API_BASE = "https://api.algrow.online/api";
const POLL_INTERVAL_MS = 4_000;
// Normal TTS completes in ~1-2 min even for 10k-char scripts. We keep the
// per-attempt poll short (10 min) so a hung Algrow worker is abandoned fast and
// the retry can resubmit a fresh job, instead of stalling the pipeline 40 min.
// Override via ALGROW_POLL_TIMEOUT_MS.
const POLL_TIMEOUT_MS = Number(process.env.ALGROW_POLL_TIMEOUT_MS) || 10 * 60 * 1000;
const STATUS_LOG_INTERVAL_MS = 30_000;

// Algrow rejects scripts shorter than this (HTTP 400 "Text must be at least 200 characters").
const MIN_SCRIPT_CHARS = 200;

// provider=elevenlabs accepts ElevenLabs voice IDs verbatim — same preset map as elevenlabs.ts / genaipro-tts.ts.
const DEFAULT_VOICE_MAP: Record<string, string> = {
  "male-fr":   "pNInz6obpgDQGcFmaJgB", // Adam
  "female-fr": "21m00Tcm4TlvDq8ikWAM", // Rachel
  "male-en":   "ErXwobaYiN019PkySvjV", // Antoni
  "female-en": "EXAVITQu4vr4xnSDxMaL", // Bella
};

export type AlgrowProvider = "elevenlabs" | "stealth";

export interface AlgrowTTSOptions {
  /** TTS engine on Algrow's side. Default elevenlabs. */
  provider?: AlgrowProvider;
  /** ElevenLabs model (provider=elevenlabs only). */
  model?: string;
  /** Playback speed multiplier. ElevenLabs hard limit [0.7, 1.2]. */
  speed?: number;
}

// eleven_v3 = the model that completed reliably/fast in testing (and matches the
// user's voice settings). eleven_multilingual_v2 was observed hanging in
// "processing" for 40min+ on Algrow's side. Override via ALGROW_TTS_MODEL.
const DEFAULT_MODEL = process.env.ALGROW_TTS_MODEL || "eleven_v3";

interface CreateJobResponse {
  success?: boolean;
  job_id?: string;
  error?: string;
  message?: string;
}

interface JobStatusResponse {
  success?: boolean;
  status?: "pending" | "processing" | "completed" | "failed" | string;
  audio_url?: string;
  error?: string;
  error_message?: string;
}

async function loadToken(): Promise<string> {
  const config = await getConfig();
  const k = process.env.ALGROW_API_KEY
    || (config as unknown as { algrowKey?: string }).algrowKey
    || "";
  if (!k) throw new Error("ALGROW_API_KEY manquante (env ou config) — requise pour voiceModel=algrow");
  return k;
}

async function createJob(
  token: string,
  script: string,
  voiceId: string,
  provider: AlgrowProvider,
  model: string,
  speed: number,
): Promise<string> {
  const form = new FormData();
  form.append("script", script);
  form.append("voice_id", voiceId);
  form.append("provider", provider);
  if (provider === "elevenlabs") {
    form.append("model_id", model);
    form.append("stability", "0.5");
    form.append("similarity_boost", "0.75");
    form.append("style", "0.3");
    form.append("speed", String(speed));
  }

  const res = await fetch(`${API_BASE}/generate-simple`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as CreateJobResponse;
  if (!res.ok || !data.job_id) {
    throw new Error(`Algrow TTS create failed ${res.status}: ${data.error ?? data.message ?? "no job_id"}`);
  }
  return data.job_id;
}

async function pollJob(token: string, jobId: string): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_MS;
  let lastLoggedAt = 0;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${API_BASE}/job-status/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as JobStatusResponse;
    if (data.status === "completed") {
      if (!data.audio_url) throw new Error(`Algrow TTS ${jobId}: completed but no audio_url`);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[Algrow-TTS] ${jobId.slice(0, 8)}… completed after ${elapsed}s`);
      return data.audio_url;
    }
    if (data.status === "failed") {
      throw new Error(`Algrow TTS ${jobId} failed: ${data.error_message ?? data.error ?? "unknown"}`);
    }
    const now = Date.now();
    if (now - lastLoggedAt >= STATUS_LOG_INTERVAL_MS || data.status !== lastStatus) {
      const elapsed = Math.round((now - startedAt) / 1000);
      console.log(`[Algrow-TTS] ${jobId.slice(0, 8)}… status=${data.status ?? "?"} (elapsed ${elapsed}s)`);
      lastLoggedAt = now;
      lastStatus = data.status;
    }
  }
  throw new Error(`Algrow TTS ${jobId} timeout after ${POLL_TIMEOUT_MS / 1000}s`);
}

export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
  options: AlgrowTTSOptions = {},
): Promise<VoiceoverResult> {
  const token = await loadToken();

  if (script.length < MIN_SCRIPT_CHARS) {
    throw new Error(`Algrow TTS exige au moins ${MIN_SCRIPT_CHARS} caractères (script: ${script.length}). Allonge le texte ou bascule de provider pour ce segment.`);
  }

  // Voice ID resolution: raw ElevenLabs ID (16-32 alnum) → preset map → fallback male-fr.
  const looksLikeVoiceId = /^[A-Za-z0-9]{16,32}$/.test(voix);
  const voiceId = looksLikeVoiceId
    ? voix
    : DEFAULT_VOICE_MAP[voix] || DEFAULT_VOICE_MAP["male-fr"];

  const provider = options.provider ?? "elevenlabs";
  const model = options.model ?? DEFAULT_MODEL;
  // ElevenLabs caps speed to [0.7, 1.2] — clamp here so atempo carries the rest downstream.
  const speed = Math.max(0.7, Math.min(1.2, options.speed ?? 1));

  // Robustness: an Algrow worker can hang a job in "processing" indefinitely
  // (observed 40min+ stuck) → a single submission is NOT safe for the pipeline.
  // We resubmit a FRESH job on timeout/failure — a hung job is a stuck worker,
  // and a new submission gets a different one. POLL_TIMEOUT_MS is kept short so
  // a hang is abandoned fast instead of stalling the whole pipeline.
  const MAX_ATTEMPTS = 3;
  let audioUrl = "";
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[Algrow-TTS] job submit attempt ${attempt}/${MAX_ATTEMPTS} (provider=${provider}, voice=${voiceId.slice(0, 8)}…, model=${model}, speed=${speed}, ${script.length} chars)`);
      const jobId = await createJob(token, script, voiceId, provider, model, speed);
      audioUrl = await pollJob(token, jobId);
      break;
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[Algrow-TTS] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastErr.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!audioUrl) throw new Error(`Algrow TTS échec après ${MAX_ATTEMPTS} tentatives: ${lastErr?.message}`);

  const res = await fetch(audioUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Algrow TTS download ${res.status}: ${audioUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buf);

  // Whisper alignment downstream replaces this estimate with the real duration.
  const durationSeconds = Math.round(script.split(/\s+/).length / 2.5);
  console.log(`[Algrow-TTS] OK → ${outputPath} (~${durationSeconds}s, ${(buf.length / 1024).toFixed(0)} KB)`);
  return { audioPath: outputPath, durationSeconds };
}
