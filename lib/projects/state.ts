import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from "fs";
import path from "path";
import type {
  ProjectState,
  ProjectSummary,
  Scene,
  SceneStatus,
} from "./types";
import { getProject } from "./registry";
import { multiRunner } from "./runner";

const ROOT = process.cwd();

interface RawScene {
  id: number;
  scene_tag?: string;
  section?: string;
  title?: string;
  vo?: string;
  duration_s?: number;
  video_prompt?: string;
  image_prompt?: string;
  animation_prompt?: string;
  epoch?: string;
  n?: number;
}

interface RawTask {
  id: number;
  section?: string;
  postedAt?: number;
  completedAt?: number;
  downloaded?: boolean;
  failed?: boolean;
  stuck?: boolean;
  qa_failed?: boolean;
  qa_reason?: string;
  error?: string;
  attempt?: number;
  url?: string;
  path?: string;
}

interface RawState {
  videos?: Record<string, RawTask>;
  images?: Record<string, RawTask>;
}

interface ManifestEntry {
  id: number;
  section?: string;
  scene_tag?: string;
  title?: string;
  image?: { taskId: string; url: string; path: string; attempt?: number };
  video?: { taskId: string; url: string; path: string; attempt?: number };
}

interface RawManifest {
  project?: string;
  entries?: ManifestEntry[];
}

function readJson<T>(p: string, fallback: T): T {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Append `?v=<mtimeMs>` to a public asset URL so a regenerated file (same name,
 * overwritten in place — e.g. scene_005.png after a "Regen image") actually
 * re-fetches in the browser instead of serving the stale cached copy. The value
 * is stable while the file is untouched, so normal HTTP caching still applies.
 */
function withCacheBust(relUrl: string, absPath: string): string {
  try {
    return `${relUrl}?v=${Math.floor(statSync(absPath).mtimeMs)}`;
  } catch {
    return relUrl;
  }
}

function publicUrlFor(localPath: string | undefined): string | undefined {
  if (!localPath) return undefined;
  const idx = localPath.indexOf("/public/");
  if (idx === -1) return undefined;
  const rel = localPath.slice(idx + "/public".length);
  return withCacheBust(rel, localPath);
}

function loadScenes(promptsPath: string): RawScene[] {
  if (!existsSync(promptsPath)) return [];
  try {
    const data = JSON.parse(readFileSync(promptsPath, "utf-8"));
    if (Array.isArray(data)) {
      return data.map((entry, i) => ({
        id: typeof entry.id === "number" ? entry.id : (typeof entry.n === "number" ? entry.n : i + 1),
        ...entry,
      }));
    }
    if (Array.isArray(data?.scenes)) return data.scenes as RawScene[];
    return [];
  } catch {
    return [];
  }
}

function lastByPostedAt(tasks: RawTask[]): RawTask | undefined {
  return tasks.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))[0];
}

// Pipeline jobs (output of /pipeline) store scenes in script.json with their
// own naming convention (scene_NNN.png, clip_NNN.mp4). Load those into the
// Scene[] shape so /projects/[slug] and the Remotion editor work transparently.
interface PipelineScriptScene {
  index: number;
  narration?: string;
  imagePrompt?: string;
  durationSeconds?: number;
  motionPrompt?: string;
}
function loadPipelineScript(outDir: string): { scenes: PipelineScriptScene[]; title?: string } | null {
  const p = path.join(outDir, "script.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { title?: string; scenes?: PipelineScriptScene[] };
    if (!Array.isArray(data.scenes)) return null;
    return { scenes: data.scenes, title: data.title };
  } catch {
    return null;
  }
}

function buildPipelineProjectState(project: ProjectSummary): ProjectState {
  const script = loadPipelineScript(project.outDir);
  const scenes: Scene[] = (script?.scenes ?? []).map((sc) => {
    const padded = String(sc.index).padStart(3, "0");
    // Providers write different extensions (GenAIPro/WAN → .png, FlowMax → .jpg),
    // so probe the known image extensions instead of assuming .png — otherwise a
    // FlowMax job's .jpg scenes never resolve and the UI shows "no clip" on every
    // scene even though the images exist on disk.
    const imageRel = ["png", "jpg", "jpeg", "webp"]
      .map((ext) => `/generated/${project.slug}/images/scene_${padded}.${ext}`)
      .find((rel) => existsSync(path.join(ROOT, "public", rel.replace(/^\//, ""))));
    const clipPathRel = `/generated/${project.slug}/clips/clip_${padded}.mp4`;
    const clipAbs = path.join(ROOT, "public", clipPathRel.replace(/^\//, ""));
    const imageUrl = imageRel
      ? withCacheBust(imageRel, path.join(ROOT, "public", imageRel.replace(/^\//, "")))
      : undefined;
    const clipUrl = existsSync(clipAbs) ? withCacheBust(clipPathRel, clipAbs) : undefined;
    let status: SceneStatus = "not-started";
    if (clipUrl) status = "done";
    else if (imageUrl) status = "image-only";
    return {
      id: sc.index,
      title: sc.narration?.slice(0, 80),
      vo: sc.narration,
      videoPrompt: sc.motionPrompt || sc.imagePrompt || "",
      imagePrompt: sc.imagePrompt,
      durationSec: sc.durationSeconds,
      status,
      clipUrl,
      imageUrl,
    };
  });

  const counts = {
    total: scenes.length,
    done: scenes.filter((s) => s.status === "done").length,
    pending: 0,
    failed: 0,
    stuck: 0,
    notStarted: scenes.filter((s) => s.status === "not-started").length,
  };

  return {
    project,
    scenes,
    activeRun: multiRunner.getActive(project.slug),
    recentRuns: multiRunner.listRecent(project.slug, 5),
    counts,
  };
}

export function loadProjectState(slug: string): ProjectState | null {
  const project = getProject(slug);
  if (!project) return null;

  // Pipeline-job format: script.json drives scene listing.
  if (existsSync(path.join(project.outDir, "script.json"))) {
    return buildPipelineProjectState(project);
  }

  const promptsPath = project.promptsFile ? path.join(ROOT, project.promptsFile) : "";
  const statePath = path.join(project.outDir, "state.json");
  const manifestPath = path.join(project.outDir, "manifest.json");

  const rawScenes = promptsPath ? loadScenes(promptsPath) : [];
  const state = readJson<RawState>(statePath, { videos: {}, images: {} });
  const manifest = readJson<RawManifest>(manifestPath, { entries: [] });
  const manifestById = new Map((manifest.entries ?? []).map((e) => [e.id, e]));

  const videoTasksById = new Map<number, RawTask[]>();
  for (const v of Object.values(state.videos ?? {})) {
    if (!videoTasksById.has(v.id)) videoTasksById.set(v.id, []);
    videoTasksById.get(v.id)!.push(v);
  }
  const imageTasksById = new Map<number, RawTask[]>();
  for (const v of Object.values(state.images ?? {})) {
    if (!imageTasksById.has(v.id)) imageTasksById.set(v.id, []);
    imageTasksById.get(v.id)!.push(v);
  }

  const isI2V = project.kind === "i2v" || project.kind === "mixed";

  const scenes: Scene[] = rawScenes.map((raw): Scene => {
    const id = raw.id;
    const me = manifestById.get(id);
    const videoTasks = videoTasksById.get(id) ?? [];
    const imageTasks = imageTasksById.get(id) ?? [];
    const lastVid = lastByPostedAt(videoTasks);
    const lastImg = lastByPostedAt(imageTasks);

    const videoUrl = publicUrlFor(me?.video?.path);
    const imageUrl = publicUrlFor(me?.image?.path);

    const videoPrompt = raw.video_prompt ?? raw.animation_prompt ?? "";
    const imagePrompt = raw.image_prompt;

    const scene: Scene = {
      id,
      section: raw.section ?? raw.epoch ?? raw.scene_tag,
      title: raw.title,
      vo: raw.vo,
      videoPrompt,
      imagePrompt,
      durationSec: raw.duration_s,
      status: "not-started",
      clipUrl: videoUrl,
      imageUrl,
      videoAttempt: me?.video?.attempt ?? lastVid?.attempt,
      imageAttempt: me?.image?.attempt ?? lastImg?.attempt,
      videoTaskId: me?.video?.taskId,
      imageTaskId: me?.image?.taskId,
    };

    if (lastVid?.failed && !videoUrl) scene.videoFailed = true;
    if (lastVid?.stuck && !videoUrl) scene.videoStuck = true;
    if (lastVid && !lastVid.downloaded && !lastVid.failed && !lastVid.stuck) scene.videoProcessing = true;
    if (lastVid?.error) scene.videoError = lastVid.error;

    if (lastImg?.failed && !imageUrl) scene.imageFailed = true;
    if (lastImg?.stuck && !imageUrl) scene.imageStuck = true;
    if (lastImg && !lastImg.downloaded && !lastImg.failed && !lastImg.stuck) scene.imageProcessing = true;
    if (lastImg?.error) scene.imageError = lastImg.error;

    let status: SceneStatus = "not-started";
    if (videoUrl) status = "done";
    else if (scene.videoProcessing) status = "video-pending";
    else if (scene.videoStuck) status = "video-stuck";
    else if (scene.videoFailed) status = "video-failed";
    else if (isI2V) {
      if (imageUrl) status = "image-only";
      else if (scene.imageProcessing) status = "image-pending";
      else if (scene.imageStuck) status = "image-stuck";
      else if (scene.imageFailed) status = "image-failed";
    }
    scene.status = status;
    return scene;
  });

  const counts = {
    total: scenes.length,
    done: scenes.filter((s) => s.status === "done").length,
    pending: scenes.filter((s) => s.status === "video-pending" || s.status === "image-pending").length,
    failed: scenes.filter((s) => s.status === "video-failed" || s.status === "image-failed").length,
    stuck: scenes.filter((s) => s.status === "video-stuck" || s.status === "image-stuck").length,
    notStarted: scenes.filter((s) => s.status === "not-started").length,
  };

  return {
    project,
    scenes,
    activeRun: multiRunner.getActive(slug),
    recentRuns: multiRunner.listRecent(slug, 5),
    counts,
  };
}

export function getScene(slug: string, id: number): Scene | null {
  const state = loadProjectState(slug);
  if (!state) return null;
  return state.scenes.find((s) => s.id === id) ?? null;
}

export interface PromptPatch {
  videoPrompt?: string;
  imagePrompt?: string;
  vo?: string;
  title?: string;
}

export function patchScenePrompt(slug: string, id: number, patch: PromptPatch): { ok: boolean; error?: string } {
  const project = getProject(slug);
  if (!project) return { ok: false, error: "projet introuvable" };

  // Pipeline jobs (from /pipeline): scenes live in public/generated/<slug>/script.json
  // with camelCase keys (imagePrompt, motionPrompt, narration, durationSeconds) and
  // a numeric `index` instead of `id`.
  const scriptJsonPath = path.join(project.outDir, "script.json");
  if (existsSync(scriptJsonPath)) {
    let data: { title?: string; scenes?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(readFileSync(scriptJsonPath, "utf-8"));
    } catch (e) {
      return { ok: false, error: `parse error script.json: ${(e as Error).message}` };
    }
    if (!Array.isArray(data.scenes)) return { ok: false, error: "structure script.json inattendue" };

    const idx = data.scenes.findIndex((s) => (s.index as number) === id);
    if (idx < 0) return { ok: false, error: `scène #${id} introuvable dans script.json` };

    if (patch.imagePrompt !== undefined) data.scenes[idx].imagePrompt = patch.imagePrompt;
    if (patch.videoPrompt !== undefined) data.scenes[idx].motionPrompt = patch.videoPrompt;
    if (patch.vo !== undefined) data.scenes[idx].narration = patch.vo;
    if (patch.title !== undefined) data.scenes[idx].title = patch.title;

    const backup = scriptJsonPath.replace(/\.json$/, `.backup-${Date.now()}.json`);
    try {
      copyFileSync(scriptJsonPath, backup);
      writeFileSync(scriptJsonPath, JSON.stringify(data, null, 2));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `write error script.json: ${(e as Error).message}` };
    }
  }

  // Legacy CLI projects: top-level <slug>_prompts.json
  if (!project.promptsFile) return { ok: false, error: "promptsFile manquant" };
  const promptsPath = path.join(ROOT, project.promptsFile);
  if (!existsSync(promptsPath)) return { ok: false, error: "prompts file introuvable" };

  let raw: { scenes?: RawScene[] } | RawScene[];
  try {
    raw = JSON.parse(readFileSync(promptsPath, "utf-8"));
  } catch (e) {
    return { ok: false, error: `parse error: ${(e as Error).message}` };
  }

  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.scenes) ? raw.scenes : null;
  if (!arr) return { ok: false, error: "structure prompts inattendue" };

  const idx = arr.findIndex((s) => (typeof s.id === "number" ? s.id : s.n) === id);
  if (idx < 0) return { ok: false, error: `scène #${id} introuvable` };

  if (patch.videoPrompt !== undefined) {
    if ("video_prompt" in arr[idx] || project.kind === "t2v") arr[idx].video_prompt = patch.videoPrompt;
    else arr[idx].animation_prompt = patch.videoPrompt;
  }
  if (patch.imagePrompt !== undefined) arr[idx].image_prompt = patch.imagePrompt;
  if (patch.vo !== undefined) arr[idx].vo = patch.vo;
  if (patch.title !== undefined) arr[idx].title = patch.title;

  const backup = promptsPath.replace(/\.json$/, `.backup-${Date.now()}.json`);
  try {
    copyFileSync(promptsPath, backup);
    writeFileSync(promptsPath, JSON.stringify(raw, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `write error: ${(e as Error).message}` };
  }
}
