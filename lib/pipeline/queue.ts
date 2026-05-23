import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { startPipeline, getJob } from "./runner";
import type { PipelineJobParams } from "./types";

export type QueueEntryStatus = "waiting" | "running" | "completed" | "failed";

export interface QueueEntry {
  id: string;
  params: PipelineJobParams;
  status: QueueEntryStatus;
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  jobId?: string;
  error?: string;
}

interface QueueState {
  entries: QueueEntry[];
  workerEnabled: boolean;
}

const QUEUE_FILE = path.join(process.cwd(), "config", "pipeline-queue.json");

declare global {
  // eslint-disable-next-line no-var
  var __ff_queue_state: QueueState | undefined;
  // eslint-disable-next-line no-var
  var __ff_queue_started: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ff_queue_running: boolean | undefined;
}

function defaultState(): QueueState {
  return { entries: [], workerEnabled: true };
}

let state: QueueState = global.__ff_queue_state ?? defaultState();
global.__ff_queue_state = state;

async function persist(): Promise<void> {
  await mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  await writeFile(QUEUE_FILE, JSON.stringify(state, null, 2));
}

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await readFile(QUEUE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<QueueState>;
    if (parsed && Array.isArray(parsed.entries)) {
      state.entries = parsed.entries;
      state.workerEnabled = parsed.workerEnabled !== false;
    }
  } catch {
    // file missing — fine
  }
  // Any "running" entry from before a restart is stuck → bump back to waiting.
  for (const e of state.entries) {
    if (e.status === "running") {
      e.status = "waiting";
      delete e.startedAt;
      delete e.jobId;
    }
  }
  global.__ff_queue_state = state;
}

function generateQueueId(): string {
  return `queue_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function getQueueSnapshot(): QueueState {
  return { entries: [...state.entries], workerEnabled: state.workerEnabled };
}

export async function addToQueue(params: PipelineJobParams): Promise<QueueEntry> {
  const entry: QueueEntry = {
    id: generateQueueId(),
    params,
    status: "waiting",
    addedAt: new Date().toISOString(),
  };
  state.entries.push(entry);
  await persist();
  return entry;
}

export async function removeFromQueue(id: string): Promise<boolean> {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  if (state.entries[idx].status === "running") return false;
  state.entries.splice(idx, 1);
  await persist();
  return true;
}

export async function clearFinishedFromQueue(): Promise<number> {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.status !== "completed" && e.status !== "failed");
  await persist();
  return before - state.entries.length;
}

export async function setWorkerEnabled(enabled: boolean): Promise<void> {
  state.workerEnabled = enabled;
  await persist();
}

// --- Worker singleton ------------------------------------------------------
// One job at a time. Polls every 3s. Survives Turbopack HMR via globalThis flag.

async function workerTick(): Promise<void> {
  if (global.__ff_queue_running) return;
  if (!state.workerEnabled) return;
  const next = state.entries.find((e) => e.status === "waiting");
  if (!next) return;

  global.__ff_queue_running = true;
  next.status = "running";
  next.startedAt = new Date().toISOString();
  await persist();
  console.log(`[Queue] Start ${next.id}: "${next.params.title}"`);

  try {
    const jobId = await startPipeline(next.params);
    next.jobId = jobId;
    await persist();

    // Poll the pipeline job until it terminates.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const j = getJob(jobId);
        if (!j) return;
        if (j.status === "completed" || j.status === "failed") {
          clearInterval(interval);
          next.status = j.status;
          next.error = j.error;
          next.finishedAt = new Date().toISOString();
          persist()
            .catch((e) => console.error("[Queue] persist failed", e))
            .finally(() => resolve());
        }
      }, 2000);
    });
    console.log(`[Queue] ${(next.status as string) === "completed" ? "Done" : "Failed"} ${next.id}`);
  } catch (e) {
    next.status = "failed";
    next.error = e instanceof Error ? e.message : String(e);
    next.finishedAt = new Date().toISOString();
    await persist();
    console.error(`[Queue] Error ${next.id}: ${next.error}`);
  } finally {
    global.__ff_queue_running = false;
  }
}

export async function startQueueWorker(): Promise<void> {
  if (global.__ff_queue_started) return;
  await loadFromDisk();
  global.__ff_queue_started = true;
  setInterval(() => {
    workerTick().catch((e) => console.error("[Queue] tick error", e));
  }, 3000);
  console.log(`[Queue] Worker started — ${state.entries.length} entry(ies), workerEnabled=${state.workerEnabled}`);
}
