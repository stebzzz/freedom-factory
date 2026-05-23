import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { loadProjectState } from "@/lib/projects/state";
import { getProject } from "@/lib/projects/registry";
import { FPS } from "@/remotion/types";
import type { RemotionClip, MontageCompositionProps } from "@/remotion/types";

export const dynamic = "force-dynamic";

// Run `ffprobe` to read the exact duration of a media file. Falls back to the
// scene's scripted durationSec when ffprobe can't read the file (mock clips,
// missing files, ffprobe not on PATH).
function probeDurationSeconds(absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!existsSync(absPath)) return resolve(null);
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      absPath,
    ];
    let stdout = "";
    let stderr = "";
    const proc = spawn("ffprobe", args);
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr) console.warn(`[remotion-data] ffprobe stderr: ${stderr.slice(0, 200)}`);
        return resolve(null);
      }
      const value = parseFloat(stdout.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

// Default fallback when ffprobe is unavailable. Veo3 clips are typically 8s.
const DEFAULT_CLIP_DURATION_S = 8;

interface ResolvedClip {
  id: number;
  label: string;
  absPath: string;
  scriptedDurationSec?: number;
  prompt?: string;
}

// Best-effort prompt lookup: read <outDir>/prompts.json and index by scene n/id.
function loadPromptIndex(outDir: string): Map<number, string> {
  const out = new Map<number, string>();
  const p = path.join(outDir, "prompts.json");
  if (!existsSync(p)) return out;
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    const list: unknown[] = Array.isArray(data) ? data : Array.isArray((data as { scenes?: unknown[] }).scenes) ? (data as { scenes: unknown[] }).scenes : [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      const idCandidate = typeof obj.n === "number" ? obj.n : typeof obj.id === "number" ? obj.id : null;
      if (idCandidate === null) continue;
      const promptCandidate =
        typeof obj.prompt === "string" ? obj.prompt :
        typeof obj.video_prompt === "string" ? obj.video_prompt :
        typeof obj.animation_prompt === "string" ? obj.animation_prompt : null;
      if (promptCandidate) out.set(idCandidate, promptCandidate);
    }
  } catch (err) {
    console.warn("[remotion-data] prompts.json parse failed:", (err as Error).message);
  }
  return out;
}

// Build a clip list from the best available source:
//   1) ProjectState.scenes (when the project is registered with a prompts file).
//   2) Manifest.json entries (works for projects created via stand-alone scripts).
//   3) Filesystem fallback — scan public/generated/<slug>/clips/ and sort by leading number.
function resolveCandidates(slug: string): ResolvedClip[] {
  const projectAbsRoot = process.cwd();
  const summary = getProject(slug);
  const outDir = summary?.outDir ?? path.join(projectAbsRoot, "public", "generated", slug);
  const promptIdx = loadPromptIndex(outDir);

  const state = loadProjectState(slug);
  if (state && state.scenes.length > 0) {
    return state.scenes
      .filter((s) => !!s.clipUrl)
      .sort((a, b) => a.id - b.id)
      .map((scene) => ({
        id: scene.id,
        label: scene.title || scene.section || `Scene ${scene.id}`,
        absPath: path.join(projectAbsRoot, "public", scene.clipUrl!.replace(/^\//, "")),
        scriptedDurationSec: scene.durationSec,
        prompt: scene.videoPrompt || promptIdx.get(scene.id),
      }));
  }

  if (!summary) return [];

  // Manifest fallback (Pandora/Revolution style projects).
  const manifestPath = path.join(summary.outDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        entries?: Array<{ id?: number; n?: number; title?: string; video?: { path?: string } }>;
      };
      const entries = (data.entries ?? [])
        .filter((e) => !!e.video?.path)
        .map((e) => {
          const id = (typeof e.id === "number" ? e.id : (typeof e.n === "number" ? e.n : 0));
          return {
            id,
            label: e.title ?? `Scene ${e.id ?? e.n ?? "?"}`,
            absPath: e.video!.path!,
            scriptedDurationSec: undefined as number | undefined,
            prompt: promptIdx.get(id),
          };
        })
        .filter((e) => e.absPath && existsSync(e.absPath))
        .sort((a, b) => a.id - b.id);
      if (entries.length > 0) return entries;
    } catch (err) {
      console.warn(`[remotion-data] manifest parse failed for ${slug}:`, (err as Error).message);
    }
  }

  // Filesystem fallback — pure clip directory scan.
  const clipsDir = path.join(summary.outDir, "clips");
  if (!existsSync(clipsDir)) return [];
  return readdirSync(clipsDir)
    .filter((f) => /\.(mp4|mov|webm)$/i.test(f))
    .map((f) => {
      const m = f.match(/^(\d+)/);
      const id = m ? parseInt(m[1], 10) : 0;
      return {
        id,
        label: f.replace(/\.[^.]+$/, "").replace(/_/g, " "),
        absPath: path.join(clipsDir, f),
        scriptedDurationSec: undefined as number | undefined,
        prompt: promptIdx.get(id),
      };
    })
    .sort((a, b) => a.id - b.id);
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const summary = getProject(slug);
  if (!summary) return NextResponse.json({ error: `projet '${slug}' inconnu` }, { status: 404 });

  const candidates = resolveCandidates(slug);
  const projectAbsRoot = process.cwd();

  const clipBases = await Promise.all(candidates.map(async (c, i) => {
    const probedSec = await probeDurationSeconds(c.absPath);
    const durationSec = probedSec ?? c.scriptedDurationSec ?? DEFAULT_CLIP_DURATION_S;
    const durationInFrames = Math.max(1, Math.round(durationSec * FPS));
    const idx = c.absPath.indexOf("/public/");
    const url = idx >= 0
      ? c.absPath.slice(idx + "/public".length)
      : c.absPath.startsWith(projectAbsRoot)
        ? c.absPath.slice(projectAbsRoot.length)
        : c.absPath;
    return { i, c, url, durationInFrames };
  }));

  // Place all clips on track 0 (V1) back-to-back. The editor can then move
  // them to other tracks or shift them in time.
  let cursor = 0;
  const clips: RemotionClip[] = clipBases.map(({ i, c, url, durationInFrames }) => {
    const startFrame = cursor;
    cursor += durationInFrames;
    return {
      id: `clip-${c.id || i}-${i}`,
      url,
      durationInFrames,
      label: c.label,
      startFrame,
      trackIndex: 0,
      sceneId: c.id,
      prompt: c.prompt,
    } satisfies RemotionClip;
  });

  const totalFrames = cursor;

  const compositionProps: MontageCompositionProps = {
    clips,
    keepClipAudio: true, // sensible default for projects whose clips have Veo3 audio
    voiceoverVolume: 1.0,
    musicVolume: 0.15,
    transitionFrames: 0,
    backgroundColor: "#000000",
  };

  return NextResponse.json({
    project: summary,
    composition: compositionProps,
    meta: {
      fps: FPS,
      totalFrames,
      totalSeconds: totalFrames / FPS,
      clipCount: clips.length,
      sceneCount: summary.totalScenes || clips.length,
      missingClips: Math.max(0, (summary.totalScenes || clips.length) - clips.length),
    },
  });
}
