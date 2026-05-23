import { spawn } from "child_process";
import { readFile } from "fs/promises";
import path from "path";
import os from "os";
import type { ScriptScene } from "@/lib/pipeline/types";

const DEFAULT_MODEL = path.join(os.homedir(), ".cache/whisper-cpp-models/ggml-large-v3-turbo-q5_0.bin");
const WHISPER_BIN = process.env.WHISPER_CLI_PATH || "whisper-cli";

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperTranscript {
  language?: string;
  segments: WhisperSegment[];
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

export async function transcribeWithWhisper(
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
  const timed = expandToWords(transcript.segments);
  if (timed.length === 0) throw new Error("Whisper aligner: transcript vide");

  const totalAudioSec = transcript.segments[transcript.segments.length - 1].end;
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

  // Sanity: total should be close to audio length. If wildly off, the alignment was bad.
  const totalScenes = scenes.reduce((s, sc) => s + sc.durationSeconds, 0);
  if (totalAudioSec > 0 && Math.abs(totalScenes - totalAudioSec) / totalAudioSec > 0.4) {
    console.warn(`[Whisper] alignement suspect: ${totalScenes.toFixed(1)}s scenes vs ${totalAudioSec.toFixed(1)}s audio`);
  }

  return {
    scenes,
    totalAudioSec,
    matchedWordRatio: scriptTotal > 0 ? matchedTotal / scriptTotal : 0,
  };
}
