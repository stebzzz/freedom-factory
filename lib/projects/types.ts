export type ProjectKind = "t2v" | "i2v" | "mixed" | "full-job" | "unknown";

export interface ProjectConfig {
  slug: string;
  label: string;
  description?: string;
  icon?: string;
  script: string;
  promptsFile: string;
  kind: ProjectKind;
}

export interface ProjectSummary extends ProjectConfig {
  outDir: string;
  hasState: boolean;
  hasManifest: boolean;
  hasPrompts: boolean;
  totalScenes: number;
  clipsCount: number;
  imagesCount: number;
  doneCount: number;
  pendingCount: number;
  failedCount: number;
  stuckCount: number;
  masterUrl?: string;
  masterUpdatedAt?: number;
}

export type SceneStatus =
  | "not-started"
  | "image-pending"
  | "image-stuck"
  | "image-failed"
  | "image-only"
  | "video-pending"
  | "video-stuck"
  | "video-failed"
  | "done";

export interface Scene {
  id: number;
  section?: string;
  title?: string;
  vo?: string;
  videoPrompt: string;
  imagePrompt?: string;
  durationSec?: number;
  status: SceneStatus;
  clipUrl?: string;
  imageUrl?: string;
  videoAttempt?: number;
  imageAttempt?: number;
  videoTaskId?: string;
  imageTaskId?: string;
  videoError?: string;
  imageError?: string;
  videoProcessing?: boolean;
  imageProcessing?: boolean;
  videoStuck?: boolean;
  imageStuck?: boolean;
  videoFailed?: boolean;
  imageFailed?: boolean;
}

export type RunMode =
  | "rolling"
  | "resume"
  | "failed-only"
  | "stuck-only"
  | "regen-ids"
  | "ids-only"
  | "scene-regen-image"
  | "scene-regen-video";

export interface RunInfo {
  id: string;
  slug: string;
  mode: RunMode;
  ids?: number[];
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  status: "running" | "exited" | "killed" | "error";
  error?: string;
}

export interface ProjectState {
  project: ProjectSummary;
  scenes: Scene[];
  activeRun: RunInfo | null;
  recentRuns: RunInfo[];
  counts: {
    total: number;
    done: number;
    pending: number;
    failed: number;
    stuck: number;
    notStarted: number;
  };
}
