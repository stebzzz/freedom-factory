// Background image QC: runs Claude Vision over every scene image of a project
// and flags the broken ones. The wrapper is serial (~15-25s/image), so for a
// 280-scene job this takes ~1h — we run it detached and persist results
// incrementally to <jobDir>/image-analysis.json so the UI can poll + show
// flagged frames as they come in, and let the user batch-regen them.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProject } from "./registry";
import { findImageIssues } from "@/lib/api/claude-vision";

export interface SceneIssue {
  id: number;
  severity: "minor" | "bad";
  issues: string[];
}

export interface AnalysisState {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  startedAt: number;
  updatedAt: number;
  flagged: SceneIssue[];
  error?: string;
}

// One in-memory run per slug. The persisted JSON is the source of truth across
// process restarts; memory just avoids a file read on every poll.
const runs = new Map<string, AnalysisState>();

function analysisPath(outDir: string): string {
  return path.join(outDir, "image-analysis.json");
}

function persist(outDir: string, state: AnalysisState): void {
  try {
    writeFileSync(analysisPath(outDir), JSON.stringify(state, null, 2));
  } catch {
    /* non-blocking */
  }
}

export function getAnalysis(slug: string): AnalysisState | null {
  const mem = runs.get(slug);
  if (mem) return mem;
  const project = getProject(slug);
  if (!project) return null;
  const p = analysisPath(project.outDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as AnalysisState;
  } catch {
    return null;
  }
}

function listSceneImages(imagesDir: string): Array<{ id: number; file: string }> {
  if (!existsSync(imagesDir)) return [];
  const out: Array<{ id: number; file: string }> = [];
  for (const f of readdirSync(imagesDir)) {
    const m = f.match(/^scene_(\d+)\.(png|jpe?g|webp)$/i);
    if (m) out.push({ id: parseInt(m[1], 10), file: path.join(imagesDir, f) });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Returns true if a run was started, false if one is already running. */
export function startAnalysis(slug: string): { ok: boolean; state?: AnalysisState; error?: string } {
  const existing = runs.get(slug);
  if (existing && existing.status === "running") return { ok: false, state: existing, error: "analyse déjà en cours" };

  const project = getProject(slug);
  if (!project) return { ok: false, error: "projet inconnu" };

  const images = listSceneImages(path.join(project.outDir, "images"));
  if (images.length === 0) return { ok: false, error: "aucune image à analyser" };

  const state: AnalysisState = {
    status: "running",
    total: images.length,
    done: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    flagged: [],
  };
  runs.set(slug, state);
  persist(project.outDir, state);

  // Detached loop — not awaited. The standalone Node server keeps it alive.
  void (async () => {
    for (const img of images) {
      try {
        const res = await findImageIssues(img.file);
        if (res.severity !== "ok") {
          state.flagged.push({ id: img.id, severity: res.severity, issues: res.issues });
        }
      } catch (err) {
        // A single failed call shouldn't abort the whole run.
        console.warn(`[imageAnalysis] scene ${img.id} QC failed: ${(err as Error).message}`);
      }
      state.done += 1;
      state.updatedAt = Date.now();
      // Persist every few images so a poll/refresh sees fresh progress without
      // hammering the disk on every single one.
      if (state.done % 3 === 0 || state.done === state.total) persist(project.outDir, state);
    }
    state.status = "done";
    state.updatedAt = Date.now();
    persist(project.outDir, state);
    console.log(`[imageAnalysis] ${slug} done: ${state.flagged.length}/${state.total} flagged`);
  })();

  return { ok: true, state };
}
