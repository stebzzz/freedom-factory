import { spawn } from "child_process";
import { readFile, stat } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import os from "os";
import type { ScriptScene } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

const DEFAULT_MODEL = path.join(os.homedir(), ".cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin");
const WHISPER_BIN = process.env.WHISPER_CLI_PATH || "whisper-cli";

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperTranscript {
  language?: string;
  segments: WhisperSegment[];
  /** Per-word timings when available (OpenAI API). Undefined for whisper.cpp output. */
  words?: WhisperWord[];
}

interface WhisperJsonV1 {
  transcription?: Array<{
    offsets?: { from: number; to: number };
    timestamps?: { from: string; to: string };
    text: string;
  }>;
  result?: { language?: string };
}

function parseWhisperJson(raw: WhisperJsonV1): WhisperTranscript {
  const segments: WhisperSegment[] = [];
  for (const seg of raw.transcription ?? []) {
    if (!seg.offsets) continue;
    segments.push({
      start: seg.offsets.from / 1000,
      end: seg.offsets.to / 1000,
      text: seg.text.trim(),
    });
  }
  return { language: raw.result?.language, segments };
}

// Compress an audio file to mp3 if it exceeds OpenAI's 25 MB upload limit.
// Returns the path of the file to actually upload (may equal the input).
async function ensureUnderLimit(audioPath: string, maxBytes = 24 * 1024 * 1024): Promise<{ path: string; transient: boolean }> {
  const s = await stat(audioPath);
  if (s.size <= maxBytes) return { path: audioPath, transient: false };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");
  const compressedPath = audioPath.replace(/\.[^.]+$/, "") + ".compressed.mp3";
  console.log(`[Whisper] file ${(s.size / 1024 / 1024).toFixed(1)} MB > 24 MB — transcoding to mp3 96k for upload`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(audioPath)
      .audioCodec("libmp3lame")
      .audioBitrate("96k")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("mp3")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(compressedPath);
  });
  return { path: compressedPath, transient: true };
}

interface OpenAITranscriptionResponse {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  segments?: Array<{ id?: number; start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

/** OpenAI Whisper API (model "whisper-1") with verbose_json + word timestamps. */
async function transcribeWithOpenAI(
  audioPath: string,
  apiKey: string,
  options: { language?: string } = {},
): Promise<WhisperTranscript> {
  const { path: uploadPath, transient } = await ensureUnderLimit(audioPath);
  try {
    const form = new FormData();
    const buf = await readFile(uploadPath);
    const ext = path.extname(uploadPath).toLowerCase().slice(1) || "wav";
    const mime = ext === "mp3" ? "audio/mpeg" : ext === "m4a" || ext === "mp4" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : "audio/wav";
    form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), path.basename(uploadPath));
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (options.language) form.append("language", options.language);

    const t0 = Date.now();
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`OpenAI whisper HTTP ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const data = (await res.json()) as OpenAITranscriptionResponse;
    const segments: WhisperSegment[] = (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
    const words: WhisperWord[] = (data.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end }));
    if (segments.length === 0 && words.length === 0) {
      throw new Error("OpenAI whisper: response sans segments ni words");
    }
    console.log(`[Whisper OpenAI] ${segments.length} segments, ${words.length} words, ${data.duration?.toFixed(1) ?? "?"}s audio in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { language: data.language, segments, words };
  } finally {
    if (transient) {
      try { const { unlink } = await import("fs/promises"); await unlink(uploadPath); } catch { /* ok */ }
    }
    void createReadStream; // retained for future streaming uploads if we hit memory pressure
  }
}

async function transcribeWithCli(
  audioPath: string,
  options: { language?: string; model?: string } = {},
): Promise<WhisperTranscript> {
  const model = options.model || process.env.WHISPER_MODEL_PATH || DEFAULT_MODEL;
  const outBase = audioPath.replace(/\.[^.]+$/, "") + ".whisper";

  const args = [
    "-m", model,
    "-l", options.language || "auto",
    "-oj",
    "-of", outBase,
    "-sow",
    audioPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(WHISPER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => reject(new Error(`whisper-cli spawn: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`whisper-cli exit ${code}: ${stderr.slice(-400)}`));
    });
  });

  const jsonPath = `${outBase}.json`;
  const raw = JSON.parse(await readFile(jsonPath, "utf-8")) as WhisperJsonV1;
  const transcript = parseWhisperJson(raw);
  if (transcript.segments.length === 0) {
    throw new Error(`whisper-cli: aucun segment retourné (fichier ${jsonPath})`);
  }
  return transcript;
}

/**
 * Transcribe audio with timestamps. Prefers OpenAI API (faster + word-level
 * timestamps for accurate alignment), falls back to local whisper-cli if no
 * OPENAI_API_KEY is set or the API call fails.
 */
export async function transcribeWithWhisper(
  audioPath: string,
  options: { language?: string; model?: string } = {},
): Promise<WhisperTranscript> {
  const config = await getConfig();
  if (config.openaiKey) {
    try {
      return await transcribeWithOpenAI(audioPath, config.openaiKey, { language: options.language });
    } catch (err) {
      console.warn(`[Whisper] OpenAI API failed (${(err as Error).message.slice(0, 160)}) — falling back to local whisper-cli`);
    }
  }
  return transcribeWithCli(audioPath, options);
}

// Normalize text for fuzzy matching: lowercase, strip punctuation, collapse whitespace.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

interface TimedWord {
  word: string;
  start: number;
  end: number;
}

// Whisper-cpp returns segments, not words, but with -sow segments roughly correspond to words/short phrases.
// We interpolate inside each segment to estimate per-word timing for matching.
function expandToWords(segments: WhisperSegment[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of segments) {
    const segWords = tokens(seg.text);
    if (segWords.length === 0) continue;
    const span = Math.max(0.01, seg.end - seg.start);
    const per = span / segWords.length;
    for (let i = 0; i < segWords.length; i++) {
      out.push({
        word: segWords[i],
        start: seg.start + i * per,
        end: seg.start + (i + 1) * per,
      });
    }
  }
  return out;
}

export interface AlignmentResult {
  scenes: ScriptScene[];
  totalAudioSec: number;
  matchedWordRatio: number; // 0..1 — how much of the script was found in the transcript
}

/**
 * Align scenes to the actual voiceover audio using a Whisper transcript.
 * Sequential matching: scene N starts at the timestamp of its first word in the transcript.
 * Scene durations are mutated in place to match the actual audio.
 */
export async function alignScenesWithWhisper(
  scenes: ScriptScene[],
  audioPath: string,
  options: { language?: string; minSceneDuration?: number; maxSceneDuration?: number } = {},
): Promise<AlignmentResult> {
  const minDur = options.minSceneDuration ?? 1.5;
  const maxDur = options.maxSceneDuration ?? 60;

  const transcript = await transcribeWithWhisper(audioPath, { language: options.language });
  // Prefer real per-word timestamps (OpenAI verbose_json) over interpolating from segments.
  // OpenAI returns words like " C'est" or "c'est" which after normalize() become "c est" —
  // a multi-token string that never matches the script's split tokens. Expand each whisper
  // word into its sub-tokens, sharing the [start..end] window proportionally.
  let timed: TimedWord[];
  if (transcript.words && transcript.words.length > 0) {
    timed = [];
    for (const w of transcript.words) {
      const subs = tokens(w.word);
      if (subs.length === 0) continue;
      const span = Math.max(0.001, w.end - w.start);
      const per = span / subs.length;
      for (let k = 0; k < subs.length; k++) {
        timed.push({ word: subs[k], start: w.start + k * per, end: w.start + (k + 1) * per });
      }
    }
  } else {
    timed = expandToWords(transcript.segments);
  }
  if (timed.length === 0) throw new Error("Whisper aligner: transcript vide");

  const totalAudioSec = transcript.words && transcript.words.length > 0
    ? transcript.words[transcript.words.length - 1].end
    : transcript.segments[transcript.segments.length - 1].end;
  let cursor = 0;
  let matchedTotal = 0;
  let scriptTotal = 0;

  for (let i = 0; i < scenes.length; i++) {
    const sceneWords = tokens(scenes[i].narration);
    scriptTotal += sceneWords.length;
    if (sceneWords.length === 0) continue;

    // Find the best matching window starting from cursor.
    const sceneStart = timed[Math.min(cursor, timed.length - 1)].start;
    let matched = 0;
    let j = cursor;
    for (let k = 0; k < sceneWords.length && j < timed.length; k++) {
      // Skip transcript words until we find one that matches the current narration word,
      // bounded by a small lookahead so noise doesn't blow up the alignment.
      let look = 0;
      while (j < timed.length && timed[j].word !== sceneWords[k] && look < 5) {
        j++;
        look++;
      }
      if (j < timed.length && timed[j].word === sceneWords[k]) {
        matched++;
        j++;
      } else {
        // word not found in lookahead — keep cursor, move on
      }
    }
    matchedTotal += matched;
    const endIdx = Math.min(j, timed.length) - 1;
    const sceneEnd = endIdx >= 0 ? timed[Math.max(endIdx, 0)].end : sceneStart;
    cursor = Math.min(j, timed.length);

    const aligned = Math.max(minDur, Math.min(maxDur, sceneEnd - sceneStart));
    scenes[i].durationSeconds = Number(aligned.toFixed(2));
  }

  // If matching tanked (transcription drift, different language, paraphrased VO),
  // the per-scene alignment is useless. Fall back to proportional distribution:
  // each scene gets a share of totalAudioSec proportional to its narration length.
  // Visually less precise than true word alignment, but the cumulative drift is
  // bounded — and the master ends exactly when the audio ends.
  const ratio = scriptTotal > 0 ? matchedTotal / scriptTotal : 0;
  if (ratio < 0.3 && totalAudioSec > 0) {
    console.warn(`[Whisper] match ratio ${(ratio * 100).toFixed(0)}% — falling back to proportional distribution over ${totalAudioSec.toFixed(1)}s audio`);
    const weights = scenes.map((s) => Math.max(1, tokens(s.narration).length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < scenes.length; i++) {
      const share = (weights[i] / totalWeight) * totalAudioSec;
      scenes[i].durationSeconds = Number(Math.max(minDur, Math.min(maxDur, share)).toFixed(2));
    }
  } else {
    // Sanity: total should be close to audio length. If wildly off, the alignment was bad.
    const totalScenes = scenes.reduce((s, sc) => s + sc.durationSeconds, 0);
    if (totalAudioSec > 0 && Math.abs(totalScenes - totalAudioSec) / totalAudioSec > 0.4) {
      console.warn(`[Whisper] alignement suspect: ${totalScenes.toFixed(1)}s scenes vs ${totalAudioSec.toFixed(1)}s audio`);
    }
  }

  return {
    scenes,
    totalAudioSec,
    matchedWordRatio: scriptTotal > 0 ? matchedTotal / scriptTotal : 0,
  };
}
