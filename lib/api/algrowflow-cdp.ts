import { writeFile } from "fs/promises";
import { spawn } from "child_process";
import { VoiceoverResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

// AlgrowFlow CDP — VPS service driving ElevenLabs through a logged-in Chrome
// session (unlimited generations, no per-API-key quota). This is the ONLY
// reliable voice backend as of 2026-07-08: both api.algrow.online and the
// direct ElevenLabs key are dead (401 invalid_api_key). Endpoint:
//   POST /api/generate      { script, voice_id } → { id, statusUrl }
//   GET  /api/job/:id                            → { status, audioUrl }
// Auth: Authorization: Bearer <algrowflowCdpToken>.
const API_BASE = "https://voice.ytaa.fr/api";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = Number(process.env.ALGROWFLOW_POLL_TIMEOUT_MS) || 20 * 60 * 1000;
const STATUS_LOG_INTERVAL_MS = 30_000;

const MIN_SCRIPT_CHARS = 200;

const DEFAULT_VOICE_MAP: Record<string, string> = {
  "male-fr":   "pNInz6obpgDQGcFmaJgB",
  "female-fr": "21m00Tcm4TlvDq8ikWAM",
  "male-en":   "ErXwobaYiN019PkySvjV",
  "female-en": "EXAVITQu4vr4xnSDxMaL",
};

async function loadToken(): Promise<string> {
  const config = await getConfig();
  const t = process.env.ALGROWFLOW_CDP_TOKEN
    || (config as unknown as { algrowflowCdpToken?: string }).algrowflowCdpToken
    || "";
  if (!t) throw new Error("algrowflowCdpToken manquant (config/settings.json) — requis pour la voix AlgrowFlow CDP");
  return t;
}

async function createJob(token: string, script: string, voiceId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ script, voice_id: voiceId }),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !data.id) {
    throw new Error(`AlgrowFlow CDP create failed ${res.status}: ${data.error ?? "no id"}`);
  }
  return data.id;
}

async function pollJob(token: string, jobId: string): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_MS;
  let lastLoggedAt = 0;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${API_BASE}/job/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string; audioUrl?: string; error?: string;
    };
    if (data.status === "done") {
      if (!data.audioUrl) throw new Error(`AlgrowFlow CDP ${jobId}: done mais pas d'audioUrl`);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[AlgrowFlow-CDP] ${jobId.slice(0, 8)}… done après ${elapsed}s`);
      return data.audioUrl;
    }
    if (data.status === "failed" || data.status === "error") {
      throw new Error(`AlgrowFlow CDP ${jobId} failed: ${data.error ?? "unknown"}`);
    }
    const now = Date.now();
    if (now - lastLoggedAt >= STATUS_LOG_INTERVAL_MS || data.status !== lastStatus) {
      const elapsed = Math.round((now - startedAt) / 1000);
      console.log(`[AlgrowFlow-CDP] ${jobId.slice(0, 8)}… status=${data.status ?? "?"} (elapsed ${elapsed}s)`);
      lastLoggedAt = now;
      lastStatus = data.status;
    }
  }
  throw new Error(`AlgrowFlow CDP ${jobId} timeout after ${POLL_TIMEOUT_MS / 1000}s`);
}

/** ffmpeg: convert whatever AlgrowFlow returns (m4a/mp3) to 44.1kHz mono pcm_s16le wav. */
async function convertToWav(srcPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", srcPath,
      "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le",
      outputPath,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg convert failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}

export async function generateVoiceover(
  script: string,
  voix: string,
  outputPath: string,
  options: { speed?: number } = {},
): Promise<VoiceoverResult> {
  const token = await loadToken();

  if (script.length < MIN_SCRIPT_CHARS) {
    throw new Error(`AlgrowFlow CDP exige au moins ${MIN_SCRIPT_CHARS} caractères (script: ${script.length}).`);
  }

  const voiceId = voix ? (DEFAULT_VOICE_MAP[voix] ?? voix) : DEFAULT_VOICE_MAP["male-en"];
  void options.speed; // AlgrowFlow CDP n'a pas de contrôle vitesse natif — atempo downstream s'en charge.

  const MAX_ATTEMPTS = 2;
  let audioUrl = "";
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[AlgrowFlow-CDP] job submit attempt ${attempt}/${MAX_ATTEMPTS} (voice=${voiceId.slice(0, 8)}…, ${script.length} chars)`);
      const jobId = await createJob(token, script, voiceId);
      audioUrl = await pollJob(token, jobId);
      break;
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[AlgrowFlow-CDP] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastErr.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!audioUrl) throw new Error(`AlgrowFlow CDP échec après ${MAX_ATTEMPTS} tentatives: ${lastErr?.message}`);

  const res = await fetch(audioUrl, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`AlgrowFlow CDP download ${res.status}: ${audioUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const rawPath = `${outputPath}.src${audioUrl.includes(".m4a") ? ".m4a" : ".mp3"}`;
  await writeFile(rawPath, buf);
  await convertToWav(rawPath, outputPath);

  const durationSeconds = Math.round(script.split(/\s+/).length / 2.5);
  console.log(`[AlgrowFlow-CDP] OK → ${outputPath} (~${durationSeconds}s, ${(buf.length / 1024).toFixed(0)} KB source)`);
  return { audioPath: outputPath, durationSeconds };
}
