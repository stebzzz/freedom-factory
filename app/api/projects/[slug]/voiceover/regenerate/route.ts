// Regenerate the project's voiceover from its script via Algrow (the single TTS
// provider used by ChannelFlow channels), native base speed — no atempo and NO
// silence removal (it butchered the audio), then re-align scene durations to the
// new audio with Whisper so the montage stays in sync. The previous voiceover.wav
// is backed up to voiceover.prev-<ts>.wav.
//
// Runs as a DETACHED background job: the whole pipeline takes minutes and the
// proxy cuts the HTTP connection at ~60s. POST starts it (409 if one is already
// running for this slug — prevents the double-TTS we saw on retry/double-click);
// GET polls progress. State persists to <jobDir>/voiceover-regen.json.
import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";
import { getConfig } from "@/lib/config";
import { generateVoiceover } from "@/lib/api/voiceover";
import { alignScenesWithWhisper, detectScriptLanguage } from "@/lib/api/whisper";
import type { ScriptScene } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

interface ScriptJson {
  title?: string;
  niche?: string;
  wordCount?: number;
  scenes?: ScriptScene[];
}

type RegenStep = "tts" | "transcode" | "clean" | "align" | "done" | "error";
interface RegenState {
  status: "running" | "done" | "error";
  step: RegenStep;
  startedAt: number;
  updatedAt: number;
  chars?: number;
  silencesCleaned?: boolean;
  aligned?: boolean;
  matchPct?: number | null;
  totalAudioSec?: number | null;
  error?: string;
}

// One in-memory run per slug. Source of truth = the persisted JSON (survives the
// connection drop + page refresh); memory just gives the running lock.
const runs = new Map<string, RegenState>();

function statePath(outDir: string): string {
  return path.join(outDir, "voiceover-regen.json");
}
function persist(outDir: string, s: RegenState): void {
  try { writeFileSync(statePath(outDir), JSON.stringify(s, null, 2)); } catch { /* non-blocking */ }
}
function readState(outDir: string): RegenState | null {
  const p = statePath(outDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")) as RegenState; } catch { return null; }
}

function transcodeToWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-i", input, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", output,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg wav exit ${code}: ${stderr.slice(-300)}`))));
  });
}

async function cleanSilencesInPlace(wavPath: string): Promise<void> {
  const scriptPath = path.join(process.cwd(), "scripts", "remove-silences-clean.mjs");
  if (!existsSync(scriptPath)) return;
  const tmpOut = `${wavPath}.clean.wav`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      scriptPath, wavPath, tmpOut, "--threshold=-35dB", "--min=0.4", "--pad=0.08", "--fade=0.02",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => reject(new Error(`remove-silences spawn: ${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`remove-silences exit ${code}: ${stderr.slice(-300)}`))));
  });
  await rename(tmpOut, wavPath);
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const mem = runs.get(slug);
  if (mem) return NextResponse.json(mem);
  const project = getProject(slug);
  if (!project) return NextResponse.json({ status: "none" });
  const persisted = readState(project.outDir);
  return NextResponse.json(persisted ?? { status: "none" });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  // Concurrency lock — refuse a second run while one is in flight.
  const existing = runs.get(slug);
  if (existing && existing.status === "running") {
    return NextResponse.json({ error: "régénération déjà en cours", state: existing }, { status: 409 });
  }

  const scriptPath = path.join(project.outDir, "script.json");
  if (!existsSync(scriptPath)) {
    return NextResponse.json({ error: "script.json absent — pas un job pipeline" }, { status: 400 });
  }
  let data: ScriptJson;
  try {
    data = JSON.parse(readFileSync(scriptPath, "utf-8")) as ScriptJson;
  } catch {
    return NextResponse.json({ error: "script.json illisible" }, { status: 500 });
  }
  const scenes = data.scenes ?? [];
  if (scenes.length === 0) return NextResponse.json({ error: "aucune scène dans le script" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { voix?: string; align?: boolean; cleanSilences?: boolean; alignOnly?: boolean };
  const config = await getConfig();
  // ChannelFlow voix = Algrow uniquement (provider TTS unique des chaînes). On régénère
  // donc avec Algrow, pas ElevenLabs, pour rester cohérent avec la voix publiée.
  const voix = body.voix || config.algrowVoiceId || config.elevenlabsVoiceId || "male-en";
  // alignOnly = re-sync scene durations to the EXISTING voiceover.wav (no new TTS,
  // no silence pass). Fixes projects whose script.json durations never matched the
  // real audio (uploaded jobs aligned with the old code, or a stale alignment).
  const alignOnly = body.alignOnly === true;
  const doAlign = alignOnly ? true : body.align !== false;
  // Silence removal DÉSACTIVÉ par défaut : il charcutait l'audio (coupures brusques,
  // sauts). On garde la voix off Algrow originale telle quelle, alignée par Whisper.
  // Opt-in explicite seulement (cleanSilences:true) — ne JAMAIS le remettre par défaut.
  const doClean = !alignOnly && body.cleanSilences === true;

  if (alignOnly && !existsSync(path.join(project.outDir, "voiceover.wav"))) {
    return NextResponse.json({ error: "voiceover.wav absent — rien à resynchroniser" }, { status: 400 });
  }

  const fullScript = scenes.map((s) => s.narration?.trim()).filter(Boolean).join("\n\n");
  if (!fullScript) return NextResponse.json({ error: "narrations vides" }, { status: 400 });

  const state: RegenState = {
    status: "running", step: alignOnly ? "align" : "tts", startedAt: Date.now(), updatedAt: Date.now(), chars: fullScript.length,
  };
  runs.set(slug, state);
  persist(project.outDir, state);
  const bump = (step: RegenStep) => { state.step = step; state.updatedAt = Date.now(); persist(project.outDir, state); };

  // Detached pipeline — not awaited. POST returns immediately.
  void (async () => {
    const voPath = path.join(project.outDir, "voiceover.wav");
    const tmpMp3 = path.join(tmpdir(), `regen-vo-${slug}-${Date.now()}.mp3`);
    try {
      if (!alignOnly) {
        // 1) TTS — Algrow (provider unique des chaînes ChannelFlow)
        await generateVoiceover(fullScript, voix, tmpMp3, { voiceModel: "algrow" });
        if (!existsSync(tmpMp3)) throw new Error("TTS n'a produit aucun fichier");

        // 2) backup + transcode to wav
        bump("transcode");
        if (existsSync(voPath)) {
          await copyFile(voPath, path.join(project.outDir, `voiceover.prev-${Date.now()}.wav`)).catch(() => {});
        }
        await transcodeToWav(tmpMp3, voPath);
        await unlink(tmpMp3).catch(() => {});

        // 2.5) clean silences
        if (doClean) {
          bump("clean");
          try { await cleanSilencesInPlace(voPath); state.silencesCleaned = true; }
          catch (err) { console.warn(`[regen-vo] nettoyage silences échec: ${(err as Error).message}`); }
        }
      }

      // 3) whisper align
      if (doAlign) {
        bump("align");
        try {
          const language = detectScriptLanguage(scenes.map((s) => s.narration ?? ""));
          const aligned = await alignScenesWithWhisper(scenes, voPath, { language });
          state.matchPct = Math.round(aligned.matchedWordRatio * 100);
          state.totalAudioSec = Math.round(aligned.totalAudioSec * 10) / 10;
          state.aligned = true;
          writeFileSync(scriptPath, JSON.stringify(
            { title: data.title, niche: data.niche, wordCount: data.wordCount, scenes }, null, 2,
          ));
        } catch (err) {
          console.warn(`[regen-vo] Whisper align échec: ${(err as Error).message}`);
          state.aligned = false;
        }
      }

      state.status = "done"; state.step = "done"; state.updatedAt = Date.now();
      persist(project.outDir, state);
      console.log(`[regen-vo] ${slug} done (${fullScript.length} chars, aligned=${state.aligned}, cleaned=${state.silencesCleaned})`);
    } catch (err) {
      await unlink(tmpMp3).catch(() => {});
      state.status = "error"; state.step = "error"; state.error = (err as Error).message; state.updatedAt = Date.now();
      persist(project.outDir, state);
      console.warn(`[regen-vo] ${slug} ÉCHEC: ${state.error}`);
    }
  })();

  return NextResponse.json({ ok: true, started: true, state });
}
