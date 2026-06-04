import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import type { ProjectConfig, ProjectKind, ProjectSummary } from "./types";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "config/projects.json");
const GENERATED_DIR = path.join(ROOT, "public/generated");

interface ConfigFile {
  projects: ProjectConfig[];
}

function loadConfig(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return { projects: [] };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ConfigFile;
  } catch {
    return { projects: [] };
  }
}

function inferKindFromName(slug: string): ProjectKind {
  if (slug.endsWith("_veo3") || slug.endsWith("_t2v")) return "t2v";
  if (slug.startsWith("job_")) return "full-job";
  if (slug.includes("evolution") || slug.includes("genaipro")) return "mixed";
  return "unknown";
}

function autoDetectScript(slug: string): string {
  const candidates = [
    `scripts/gen-${slug}.mjs`,
    `scripts/gen-${slug.replace(/_/g, "-")}.mjs`,
    `scripts/run-${slug.replace(/^job_/, "").replace(/_full$/, "")}-job.mjs`,
  ];
  for (const c of candidates) {
    if (existsSync(path.join(ROOT, c))) return c;
  }
  return "";
}

function autoDetectPromptsFile(slug: string): string {
  const candidates = [
    `${slug}_prompts.json`,
    `${slug.replace(/_/g, "-")}_prompts.json`,
    `${slug}.json`,
  ];
  for (const c of candidates) {
    if (existsSync(path.join(ROOT, c))) return c;
  }
  return "";
}

function listGeneratedDirs(): string[] {
  if (!existsSync(GENERATED_DIR)) return [];
  return readdirSync(GENERATED_DIR).filter((name) => {
    if (name.startsWith(".") || name === "old") return false;
    const fp = path.join(GENERATED_DIR, name);
    try {
      return statSync(fp).isDirectory();
    } catch {
      return false;
    }
  });
}

function countClips(slug: string): { clips: number; images: number; master?: { url: string; mtime: number } } {
  const out = path.join(GENERATED_DIR, slug);
  let clips = 0;
  let images = 0;
  const clipsDir = path.join(out, "clips");
  if (existsSync(clipsDir)) {
    clips = readdirSync(clipsDir).filter((f) => /\.(mp4|webm|mov)$/i.test(f)).length;
  }
  const imagesDir = path.join(out, "images");
  if (existsSync(imagesDir)) {
    images = readdirSync(imagesDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
  }
  // Both naming conventions: CLI writes "master.mp4", the pipeline writes "output.mp4".
  for (const candidate of ["master.mp4", "output.mp4"]) {
    const p = path.join(out, candidate);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      return { clips, images, master: { url: `/generated/${slug}/${candidate}`, mtime: m } };
    }
  }
  return { clips, images };
}

function countScenes(promptsFile: string): number {
  if (!promptsFile) return 0;
  const p = path.join(ROOT, promptsFile);
  if (!existsSync(p)) return 0;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(data)) return data.length;
    if (Array.isArray(data?.scenes)) return data.scenes.length;
    return 0;
  } catch {
    return 0;
  }
}

function countStateStatuses(slug: string): { done: number; pending: number; failed: number; stuck: number } {
  const statePath = path.join(GENERATED_DIR, slug, "state.json");
  if (!existsSync(statePath)) return { done: 0, pending: 0, failed: 0, stuck: 0 };
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
      videos?: Record<string, { id: number; downloaded?: boolean; failed?: boolean; stuck?: boolean }>;
      images?: Record<string, { id: number; downloaded?: boolean; failed?: boolean; stuck?: boolean }>;
    };
    const tracker = new Map<number, { done?: boolean; failed?: boolean; stuck?: boolean; pending?: boolean }>();
    const ingest = (rec: typeof state.videos) => {
      if (!rec) return;
      const arr = Object.values(rec);
      const byId = new Map<number, typeof arr>();
      for (const v of arr) {
        const list = byId.get(v.id) ?? [];
        list.push(v);
        byId.set(v.id, list);
      }
      for (const [id, attempts] of byId) {
        const slot = tracker.get(id) ?? {};
        if (attempts.some((a) => a.downloaded)) slot.done = true;
        else if (attempts.every((a) => a.failed)) slot.failed = true;
        else if (attempts.some((a) => a.stuck)) slot.stuck = true;
        else slot.pending = true;
        tracker.set(id, slot);
      }
    };
    ingest(state.videos);
    let done = 0, pending = 0, failed = 0, stuck = 0;
    for (const slot of tracker.values()) {
      if (slot.done) done++;
      else if (slot.failed) failed++;
      else if (slot.stuck) stuck++;
      else if (slot.pending) pending++;
    }
    return { done, pending, failed, stuck };
  } catch {
    return { done: 0, pending: 0, failed: 0, stuck: 0 };
  }
}

// Pipeline jobs (from /pipeline) write their structured script to script.json
// instead of a top-level prompts file. We surface that here so the project list
// and the slug page see the right title + scene count.
function readPipelineScript(slug: string): { title?: string; sceneCount: number } | null {
  const p = path.join(GENERATED_DIR, slug, "script.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { title?: string; scenes?: unknown[] };
    return { title: data.title, sceneCount: Array.isArray(data.scenes) ? data.scenes.length : 0 };
  } catch {
    return null;
  }
}

function buildSummary(cfg: ProjectConfig): ProjectSummary {
  const outDir = path.join(GENERATED_DIR, cfg.slug);
  const hasState = existsSync(path.join(outDir, "state.json"));
  const hasManifest = existsSync(path.join(outDir, "manifest.json"));
  const hasPrompts = cfg.promptsFile ? existsSync(path.join(ROOT, cfg.promptsFile)) : false;
  const pipelineScript = readPipelineScript(cfg.slug);
  // For pipeline jobs, script.json is the source of truth.
  const totalScenes = pipelineScript ? pipelineScript.sceneCount : countScenes(cfg.promptsFile);
  const { clips, images, master } = countClips(cfg.slug);
  const stateCounts = countStateStatuses(cfg.slug);
  const doneCount = Math.max(stateCounts.done, clips);
  return {
    ...cfg,
    // Prefer the user-typed title from the pipeline form when present.
    label: pipelineScript?.title ?? cfg.label,
    outDir,
    hasState,
    hasManifest,
    hasPrompts,
    totalScenes,
    clipsCount: clips,
    imagesCount: images,
    doneCount,
    pendingCount: stateCounts.pending,
    failedCount: stateCounts.failed,
    stuckCount: stateCounts.stuck,
    masterUrl: master?.url,
    masterUpdatedAt: master?.mtime,
  };
}

export function listProjects(): ProjectSummary[] {
  const config = loadConfig();
  const known = new Map(config.projects.map((p) => [p.slug, p]));
  const seen = new Set<string>();
  const summaries: ProjectSummary[] = [];

  for (const cfg of config.projects) {
    seen.add(cfg.slug);
    summaries.push(buildSummary(cfg));
  }

  for (const slug of listGeneratedDirs()) {
    if (seen.has(slug)) continue;
    const fromConfig = known.get(slug);
    const cfg: ProjectConfig = fromConfig ?? {
      slug,
      label: slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      script: autoDetectScript(slug),
      promptsFile: autoDetectPromptsFile(slug),
      kind: inferKindFromName(slug),
    };
    summaries.push(buildSummary(cfg));
  }

  return summaries.sort((a, b) => {
    // Plus récent en premier : masterUpdatedAt (date vidéo finale) puis imagesCount puis slug
    const aTime = a.masterUpdatedAt ?? 0;
    const bTime = b.masterUpdatedAt ?? 0;
    if (bTime !== aTime) return bTime - aTime;
    if (b.imagesCount !== a.imagesCount) return b.imagesCount - a.imagesCount;
    return b.slug.localeCompare(a.slug);
  });
}

export function getProject(slug: string): ProjectSummary | null {
  return listProjects().find((p) => p.slug === slug) ?? null;
}

export function getProjectConfig(slug: string): ProjectConfig | null {
  const summary = getProject(slug);
  if (!summary) return null;
  const { outDir: _o, hasState: _hs, hasManifest: _hm, hasPrompts: _hp, totalScenes: _t, clipsCount: _c, imagesCount: _i, doneCount: _d, pendingCount: _p, failedCount: _f, stuckCount: _st, masterUrl: _mu, masterUpdatedAt: _ma, ...cfg } = summary;
  return cfg;
}
