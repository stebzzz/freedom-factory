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
    const persisted = JSON.parse(readFileSync(p, "utf-8")) as AnalysisState;
    // Zombie guard: a persisted "running" with no in-memory run means the loop
    // was killed (e.g. by a redeploy). If it hasn't advanced in >2min, surface
    // it as interrupted so the UI doesn't show a forever-spinning run.
    if (persisted.status === "running" && Date.now() - (persisted.updatedAt ?? 0) > 120_000) {
      persisted.status = "error";
      persisted.error = "analyse interrompue (redémarrage serveur) — relance-la";
    }
    return persisted;
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
  // Images are QC'd 3-wide; findImageIssues uses the wrapper's "light" lane
  // (LIGHT_MAX_CONCURRENT=3) so the 3 calls actually hit the wrapper in
  // parallel rather than queueing behind the serial heavy lane.
  const CONCURRENCY = 3;
  void (async () => {
    for (let i = 0; i < images.length; i += CONCURRENCY) {
      const batch = images.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (img) => {
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
      }));
      // Keep flagged sorted by scene id (parallel pushes arrive out of order).
      state.flagged.sort((a, b) => a.id - b.id);
      persist(project.outDir, state);
    }
    state.status = "done";
    state.updatedAt = Date.now();
    persist(project.outDir, state);
    console.log(`[imageAnalysis] ${slug} done: ${state.flagged.length}/${state.total} flagged`);
  })();

  return { ok: true, state };
}
