import { spawn, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";

export type RunMode =
  | "rolling"
  | "images-only"
  | "videos-only"
  | "resume"
  | "failed-only"
  | "stuck-only"
  | "scene-regen-image"
  | "scene-regen-video"
  | "scene-generate-video";

export interface RunInfo {
  id: string;
  mode: RunMode;
  ids?: number[];
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  status: "running" | "exited" | "killed" | "error";
  log: string[];
  error?: string;
}

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, "scripts/gen-galveston.mjs");
const MAX_LOG_LINES = 500;

// Opaque wrapper so Turbopack does not analyze spawn args as dynamic imports.
function spawnNode(scriptPath: string, env: Record<string, string>, cwd: string): ChildProcess {
  const nodeBin = process.execPath;
  const args: string[] = [scriptPath];
  return spawn(nodeBin, args, { env: env as NodeJS.ProcessEnv, cwd });
}

class Runner {
  private active: { info: RunInfo; child: ChildProcess } | null = null;
  private history: RunInfo[] = [];

  isActive(): boolean { return this.active !== null && this.active.info.status === "running"; }

  getActive(): RunInfo | null { return this.active?.info ?? null; }

  listRecent(limit = 10): RunInfo[] {
    const all = [...this.history];
    if (this.active) all.unshift(this.active.info);
    return all.slice(0, limit);
  }

  start(mode: RunMode, opts: { ids?: number[]; force?: boolean } = {}): RunInfo {
    if (this.isActive() && !opts.force) {
      throw new Error("Une exécution est déjà active. Stoppe-la avant d'en lancer une autre.");
    }
    if (this.isActive() && opts.force) this.stop();

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
    };
    switch (mode) {
      case "rolling": break; // default
      case "images-only": env.IMAGES_ONLY = "1"; break;
      case "videos-only": env.VIDEOS_ONLY = "1"; break;
      case "resume": env.RESUME = "1"; break;
      case "failed-only": env.FAILED_ONLY = "1"; break;
      case "stuck-only": env.STUCK_ONLY = "1"; break;
      case "scene-regen-image":
        env.IMAGES_ONLY = "1"; env.REGEN_IMAGES = "1";
        if (opts.ids?.length) env.IDS = opts.ids.join(",");
        break;
      case "scene-regen-video":
        env.VIDEOS_ONLY = "1"; env.REGEN_VIDEOS = "1";
        if (opts.ids?.length) env.IDS = opts.ids.join(",");
        break;
      case "scene-generate-video":
        env.VIDEOS_ONLY = "1";
        if (opts.ids?.length) env.IDS = opts.ids.join(",");
        break;
    }
    if (opts.ids?.length && !env.IDS) env.IDS = opts.ids.join(",");

    const info: RunInfo = {
      id: randomBytes(6).toString("hex"),
      mode,
      ids: opts.ids,
      startedAt: Date.now(),
      status: "running",
      log: [],
    };

    const child = spawnNode(SCRIPT_PATH, env, ROOT);
    this.active = { info, child };

    const append = (chunk: Buffer, source: "stdout" | "stderr") => {
      const text = chunk.toString("utf-8");
      // Support \r progress bars (last line wins)
      for (const line of text.split(/\r?\n/)) {
        if (line === "" && !text.endsWith("\r")) continue;
        if (line.includes("\r")) {
          const last = line.split("\r").pop() || "";
          if (info.log.length > 0 && info.log[info.log.length - 1].startsWith("[stats]") || info.log[info.log.length - 1]?.match(/^\[(img|vid|.+-poll)\]/)) {
            info.log[info.log.length - 1] = `${source === "stderr" ? "[err] " : ""}${last}`;
          } else {
            info.log.push(`${source === "stderr" ? "[err] " : ""}${last}`);
          }
        } else {
          info.log.push(`${source === "stderr" ? "[err] " : ""}${line}`);
        }
        if (info.log.length > MAX_LOG_LINES) info.log.shift();
      }
    };

    child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
    child.on("error", (err) => {
      info.status = "error";
      info.error = err.message;
      info.endedAt = Date.now();
      this.history.unshift(info);
      this.active = null;
    });
    child.on("exit", (code, signal) => {
      info.endedAt = Date.now();
      info.exitCode = code;
      if (signal === "SIGTERM" || signal === "SIGKILL") info.status = "killed";
      else if (code === 0) info.status = "exited";
      else info.status = "error";
      this.history.unshift(info);
      this.active = null;
    });

    return info;
  }

  stop(): boolean {
    if (!this.active) return false;
    try {
      this.active.child.kill("SIGTERM");
      // hard-kill after 3s if still running
      const ref = this.active.child;
      setTimeout(() => { try { ref.kill("SIGKILL"); } catch {} }, 3000);
      return true;
    } catch { return false; }
  }

  getLog(taskId?: string): string[] {
    if (!taskId || taskId === this.active?.info.id) return this.active?.info.log ?? [];
    return this.history.find((r) => r.id === taskId)?.log ?? [];
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __galvestonRunner: Runner | undefined;
}

export const runner: Runner = global.__galvestonRunner ?? (global.__galvestonRunner = new Runner());

// ---- Project state aggregation ----

export const PROJECT_NAME = "galveston_1900";
const OUT_DIR = path.join(ROOT, "public/generated", PROJECT_NAME);
const PROMPTS_PATH = path.join(ROOT, `${PROJECT_NAME}_prompts.json`);
const STATE_PATH = path.join(OUT_DIR, "state.json");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

function readJSONSafe<T>(p: string, fallback: T): T {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return fallback; }
}

interface Scene {
  id: number;
  section: string;
  image_prompt: string;
  animation_prompt: string;
}
interface Spec { project: string; scenes: Scene[]; }
interface ManifestEntry {
  id: number;
  section: string;
  image?: { taskId: string; url: string; path: string; attempt?: number };
  video?: { taskId: string; url: string; path: string; attempt?: number };
}
interface Manifest { project?: string; entries: ManifestEntry[]; created_at?: number; updated_at?: number; }
interface StateTask {
  id: number; section: string;
  postedAt?: number; completedAt?: number;
  downloaded?: boolean; failed?: boolean; stuck?: boolean; qa_failed?: boolean;
  qa_reason?: string; error?: string;
  attempt?: number; url?: string; path?: string;
}
interface State { images: Record<string, StateTask>; videos: Record<string, StateTask>; }

export type SceneStatus =
  | "no-image"
  | "image-pending"
  | "image-stuck"
  | "image-failed"
  | "image-qa-failed"
  | "image-ok-no-video"
  | "video-pending"
  | "video-stuck"
  | "video-failed"
  | "completed";

export interface SceneView {
  id: number;
  section: string;
  image_prompt: string;
  animation_prompt: string;
  imagePath?: string;
  imageUrl?: string; // public URL
  videoPath?: string;
  videoUrl?: string;
  imageAttempt?: number;
  videoAttempt?: number;
  imageQAFailed?: boolean;
  imageStuck?: boolean;
  videoStuck?: boolean;
  imageFailed?: boolean;
  videoFailed?: boolean;
  imageProcessing?: boolean;
  videoProcessing?: boolean;
  imageError?: string;
  videoError?: string;
  status: SceneStatus;
}

function publicUrlFor(localPath: string | undefined): string | undefined {
  if (!localPath) return undefined;
  const idx = localPath.indexOf("/public/");
  if (idx === -1) return undefined;
  return localPath.slice(idx + "/public".length); // includes leading slash
}

export function loadProjectState(): { project: string; scenes: SceneView[]; activeRun: RunInfo | null; recentRuns: RunInfo[]; counts: Record<string, number>; } {
  const spec = readJSONSafe<Spec>(PROMPTS_PATH, { project: PROJECT_NAME, scenes: [] });
  const state = readJSONSafe<State>(STATE_PATH, { images: {}, videos: {} });
  const manifest = readJSONSafe<Manifest>(MANIFEST_PATH, { entries: [] });
  const manifestById = new Map(manifest.entries.map((e) => [e.id, e]));

  const scenes: SceneView[] = spec.scenes.map((scene) => {
    const me = manifestById.get(scene.id);
    const view: SceneView = {
      id: scene.id,
      section: scene.section,
      image_prompt: scene.image_prompt,
      animation_prompt: scene.animation_prompt,
      imagePath: me?.image?.path,
      imageUrl: publicUrlFor(me?.image?.path),
      videoPath: me?.video?.path,
      videoUrl: publicUrlFor(me?.video?.path),
      imageAttempt: me?.image?.attempt,
      videoAttempt: me?.video?.attempt,
      status: "no-image",
    };

    // Inspect current state for processing/failed/stuck (taking the most recent task for this id)
    const imageStates = Object.values(state.images).filter((s) => s.id === scene.id);
    const videoStates = Object.values(state.videos).filter((s) => s.id === scene.id);
    const lastImg = imageStates.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))[0];
    const lastVid = videoStates.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))[0];

    if (lastImg) {
      if (lastImg.qa_failed) view.imageQAFailed = true;
      if (lastImg.stuck) view.imageStuck = true;
      if (lastImg.failed) view.imageFailed = true;
      if (!lastImg.downloaded && !lastImg.failed && !lastImg.stuck && !lastImg.qa_failed) view.imageProcessing = true;
      if (lastImg.error) view.imageError = lastImg.error;
    }
    if (lastVid) {
      if (lastVid.stuck) view.videoStuck = true;
      if (lastVid.failed) view.videoFailed = true;
      if (!lastVid.downloaded && !lastVid.failed && !lastVid.stuck) view.videoProcessing = true;
      if (lastVid.error) view.videoError = lastVid.error;
    }

    if (view.videoUrl) view.status = "completed";
    else if (view.videoProcessing) view.status = "video-pending";
    else if (view.videoStuck) view.status = "video-stuck";
    else if (view.videoFailed) view.status = "video-failed";
    else if (view.imageUrl) view.status = "image-ok-no-video";
    else if (view.imageQAFailed) view.status = "image-qa-failed";
    else if (view.imageStuck) view.status = "image-stuck";
    else if (view.imageFailed) view.status = "image-failed";
    else if (view.imageProcessing) view.status = "image-pending";
    else view.status = "no-image";

    return view;
  });

  const counts = {
    total: scenes.length,
    images_done: scenes.filter((s) => !!s.imageUrl).length,
    videos_done: scenes.filter((s) => !!s.videoUrl).length,
    image_pending: scenes.filter((s) => s.status === "image-pending").length,
    video_pending: scenes.filter((s) => s.status === "video-pending").length,
    failed: scenes.filter((s) => s.imageFailed || s.videoFailed).length,
    stuck: scenes.filter((s) => s.imageStuck || s.videoStuck).length,
    qa_failed: scenes.filter((s) => s.imageQAFailed).length,
  };

  return {
    project: spec.project ?? PROJECT_NAME,
    scenes,
    activeRun: runner.getActive(),
    recentRuns: runner.listRecent(5),
    counts,
  };
}
