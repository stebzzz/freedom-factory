import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import type { RunInfo, RunMode, ProjectConfig } from "./types";
import { getProjectConfig } from "./registry";

const ROOT = process.cwd();
const MAX_LOG_LINES = 800;

// Opaque wrapper so Turbopack does not analyze spawn args as dynamic imports.
function spawnNode(scriptPath: string, env: Record<string, string>, cwd: string): ChildProcess {
  const nodeBin = process.execPath;
  const args: string[] = [scriptPath];
  return spawn(nodeBin, args, { env: env as NodeJS.ProcessEnv, cwd });
}

interface ActiveSlot {
  info: RunInfo;
  child: ChildProcess;
  log: string[];
  logPath: string;
}

class MultiRunner {
  private active = new Map<string, ActiveSlot>();
  private history = new Map<string, RunInfo[]>();

  isActive(slug: string): boolean {
    return this.active.has(slug);
  }

  getActive(slug: string): RunInfo | null {
    return this.active.get(slug)?.info ?? null;
  }

  listActiveSlugs(): string[] {
    return [...this.active.keys()];
  }

  getLog(slug: string, runId?: string): string[] {
    const slot = this.active.get(slug);
    if (!runId || (slot && runId === slot.info.id)) return slot?.log ?? [];
    return [];
  }

  listRecent(slug: string, limit = 10): RunInfo[] {
    const arr = [...(this.history.get(slug) ?? [])];
    const slot = this.active.get(slug);
    if (slot) arr.unshift(slot.info);
    return arr.slice(0, limit);
  }

  start(slug: string, mode: RunMode, opts: { ids?: number[]; force?: boolean; extraEnv?: Record<string, string> } = {}): RunInfo {
    if (this.isActive(slug) && !opts.force) {
      throw new Error(`Un run est déjà actif sur '${slug}'. Stoppe-le d'abord.`);
    }
    if (this.isActive(slug) && opts.force) this.stop(slug);

    const cfg = getProjectConfig(slug);
    if (!cfg) throw new Error(`Projet inconnu: '${slug}'`);
    if (!cfg.script) throw new Error(`Aucun script associé au projet '${slug}'`);

    const scriptPath = path.join(ROOT, cfg.script);
    if (!existsSync(scriptPath)) throw new Error(`Script introuvable: ${cfg.script}`);

    const env = buildEnv(cfg, mode, opts);

    const info: RunInfo = {
      id: randomBytes(6).toString("hex"),
      slug,
      mode,
      ids: opts.ids,
      startedAt: Date.now(),
      status: "running",
    };

    const outDir = path.join(ROOT, "public/generated", slug);
    mkdirSync(outDir, { recursive: true });
    const logPath = path.join(outDir, "run.log");

    const child = spawnNode(scriptPath, env, ROOT);
    const slot: ActiveSlot = { info, child, log: [], logPath };

    const stamp = `=== run ${info.id} | ${mode}${opts.ids?.length ? ` ids=${opts.ids.join(",")}` : ""} | ${new Date().toISOString()} ===\n`;
    try { appendFileSync(logPath, stamp); } catch {}

    const append = (chunk: Buffer, source: "stdout" | "stderr") => {
      const text = chunk.toString("utf-8");
      try { appendFileSync(logPath, source === "stderr" ? text.replace(/^/gm, "[err] ") : text); } catch {}
      for (const line of text.split(/\r?\n/)) {
        if (!line && !text.endsWith("\r")) continue;
        const segments = line.split("\r");
        const tail = segments[segments.length - 1] ?? "";
        const tag = source === "stderr" ? "[err] " : "";
        if (segments.length > 1 && slot.log.length > 0) {
          slot.log[slot.log.length - 1] = `${tag}${tail}`;
        } else if (tail) {
          slot.log.push(`${tag}${tail}`);
        }
        if (slot.log.length > MAX_LOG_LINES) slot.log.shift();
      }
    };

    child.stdout?.on("data", (c) => append(c, "stdout"));
    child.stderr?.on("data", (c) => append(c, "stderr"));
    child.on("error", (err) => {
      info.status = "error";
      info.error = err.message;
      info.endedAt = Date.now();
      this.archive(slug, info);
      this.active.delete(slug);
    });
    child.on("exit", (code, signal) => {
      info.endedAt = Date.now();
      info.exitCode = code;
      if (signal === "SIGTERM" || signal === "SIGKILL") info.status = "killed";
      else if (code === 0) info.status = "exited";
      else info.status = "error";
      this.archive(slug, info);
      this.active.delete(slug);
    });

    this.active.set(slug, slot);
    return info;
  }

  stop(slug: string): boolean {
    const slot = this.active.get(slug);
    if (!slot) return false;
    try {
      slot.child.kill("SIGTERM");
      const ref = slot.child;
      setTimeout(() => { try { ref.kill("SIGKILL"); } catch {} }, 3000);
      return true;
    } catch {
      return false;
    }
  }

  private archive(slug: string, info: RunInfo) {
    const arr = this.history.get(slug) ?? [];
    arr.unshift(info);
    while (arr.length > 20) arr.pop();
    this.history.set(slug, arr);
  }
}

function buildEnv(cfg: ProjectConfig, mode: RunMode, opts: { ids?: number[]; extraEnv?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PROJECT_NAME = cfg.slug;
  if (cfg.promptsFile) env.PROMPTS_PATH = path.join(ROOT, cfg.promptsFile);

  switch (mode) {
    case "rolling":
      break;
    case "resume":
      env.RESUME = "1";
      break;
    case "failed-only":
      env.FAILED_ONLY = "1";
      break;
    case "stuck-only":
      env.STUCK_ONLY = "1";
      break;
    case "regen-ids":
      env.REGEN = "1";
      if (opts.ids?.length) env.IDS = opts.ids.join(",");
      break;
    case "ids-only":
      if (opts.ids?.length) env.IDS = opts.ids.join(",");
      break;
    case "scene-regen-image":
      env.IMAGES_ONLY = "1";
      env.REGEN_IMAGES = "1";
      if (opts.ids?.length) env.IDS = opts.ids.join(",");
      break;
    case "scene-regen-video":
      env.VIDEOS_ONLY = "1";
      env.REGEN_VIDEOS = "1";
      if (opts.ids?.length) env.IDS = opts.ids.join(",");
      break;
  }
  if (opts.ids?.length && !env.IDS) env.IDS = opts.ids.join(",");
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);
  return env;
}

declare global {
  // eslint-disable-next-line no-var
  var __projectsMultiRunner: MultiRunner | undefined;
}

export const multiRunner: MultiRunner =
  globalThis.__projectsMultiRunner ?? (globalThis.__projectsMultiRunner = new MultiRunner());
