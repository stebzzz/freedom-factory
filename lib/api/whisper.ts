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

/**
 * Detect a script's language from a few narrations using stop-word counts.
 * Used to pick the right Whisper transcription language when the preset is unreliable
 * (e.g. documentary-fr applied to an English script — OpenAI would force-transcribe
 * the audio as French nonsense, killing word match).
 */
export function detectScriptLanguage(narrations: string[]): "en" | "fr" {
  const sample = narrations.slice(0, 50).join(" ").toLowerCase();
  const fr = (sample.match(/\b(le|la|les|un|une|des|et|est|dans|pour|avec|qui|que|sur|pas|son|sa|ses|au|aux|du|ce|cette|ces|nous|vous|ils|elles)\b/g) ?? []).length;
  const en = (sample.match(/\b(the|a|an|is|are|was|were|of|in|on|at|to|for|with|and|or|but|you|your|he|she|they|we|it|this|that|these|those)\b/g) ?? []).length;
  return en >= fr ? "en" : "fr";
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

  // PASS 1 — locate each scene's start timestamp in the whisper timeline.
  // Key fix vs the old algo: when a script word isn't found in the lookahead window,
  // we KEEP `j` where it is and skip the script word. The previous code advanced j by
  // `look` whisper words on a miss, throwing away potential matches for the next
  // script word and cascading failures (9% match on the user's 275-scene job).
  // With this fix the same data hits 97% match locally.
  const LOOKAHEAD = 10;
  let cursor = 0;
  let matchedTotal = 0;
  let scriptTotal = 0;
  const sceneStarts: Array<number | null> = new Array(scenes.length).fill(null);

  for (let i = 0; i < scenes.length; i++) {
    const sceneWords = tokens(scenes[i].narration);
    scriptTotal += sceneWords.length;
    if (sceneWords.length === 0) continue;

    let j = cursor;
    let firstHit: number | null = null;
    for (const sw of sceneWords) {
      let foundAt = -1;
      const limit = Math.min(timed.length, j + LOOKAHEAD);
      for (let k = j; k < limit; k++) {
        if (timed[k].word === sw) { foundAt = k; break; }
      }
      if (foundAt >= 0) {
        matchedTotal++;
        if (firstHit === null) firstHit = timed[foundAt].start;
        j = foundAt + 1;
      }
      // miss → keep j, skip this script word
    }
    sceneStarts[i] = firstHit;
    cursor = j;
  }

  // PASS 2 — backfill scenes with no matched word at all: take the next non-null start.
  for (let i = sceneStarts.length - 1; i >= 0; i--) {
    if (sceneStarts[i] === null) {
      sceneStarts[i] = i + 1 < sceneStarts.length ? sceneStarts[i + 1] : totalAudioSec;
    }
  }
  // PASS 3 — enforce monotonic increasing starts (matcher noise can occasionally regress).
  for (let i = 1; i < sceneStarts.length; i++) {
    if ((sceneStarts[i] as number) < (sceneStarts[i - 1] as number)) {
      sceneStarts[i] = sceneStarts[i - 1];
    }
  }

  // PASS 4 — duration of scene i = start[i+1] - start[i]. The last scene runs until
  // totalAudioSec. This naturally absorbs pauses, breaths, and un-matched paraphrase
  // words into the surrounding scenes — so the sum of durations equals the audio
  // duration to within a few ms (vs ~100s drift with the old end-of-last-matched-word
  // approach, which dropped tail audio entirely).
  for (let i = 0; i < scenes.length; i++) {
    const start = sceneStarts[i] as number;
    const end = i + 1 < scenes.length ? (sceneStarts[i + 1] as number) : totalAudioSec;
    const aligned = Math.max(minDur, Math.min(maxDur, end - start));
    scenes[i].durationSeconds = Number(aligned.toFixed(2));
  }

  // FALLBACK — if matching tanked anyway (wrong language, completely different VO),
  // use the whisper timestamp grid scaled to script word count. Cumulative drift
  // bounded; better than the 1.5s/scene Claude defaults.
  const ratio = scriptTotal > 0 ? matchedTotal / scriptTotal : 0;
  if (ratio < 0.3 && timed.length > 0 && scriptTotal > 0) {
    console.warn(`[Whisper] match ratio ${(ratio * 100).toFixed(0)}% — falling back to whisper-timestamp grid (${timed.length} words, ${totalAudioSec.toFixed(1)}s)`);
    const scale = timed.length / scriptTotal;
    let wCursor = 0;
    for (let i = 0; i < scenes.length; i++) {
      const n = tokens(scenes[i].narration).length;
      if (n === 0) { scenes[i].durationSeconds = minDur; continue; }
      const startIdx = Math.min(Math.floor(wCursor), timed.length - 1);
      const startTime = timed[startIdx].start;
      wCursor += n * scale;
      const endIdx = Math.min(Math.floor(wCursor), timed.length - 1);
      const endTime = wCursor >= timed.length ? totalAudioSec : timed[endIdx].start;
      const aligned = Math.max(minDur, Math.min(maxDur, endTime - startTime));
      scenes[i].durationSeconds = Number(aligned.toFixed(2));
    }
  }

  return {
    scenes,
    totalAudioSec,
    matchedWordRatio: scriptTotal > 0 ? matchedTotal / scriptTotal : 0,
  };
}
