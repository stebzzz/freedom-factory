import { spawn, type ChildProcess } from "child_process";
import { readdirSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getProject } from "./registry";

const ROOT = process.cwd();

export interface ConcatJob {
  id: string;
  slug: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "error";
  clipsCount: number;
  outPath?: string;
  outUrl?: string;
  error?: string;
  log: string[];
}

class ConcatRunner {
  private jobs = new Map<string, ConcatJob>();
  private active = new Map<string, ConcatJob>();
  private children = new Map<string, ChildProcess>();

  getActive(slug: string): ConcatJob | null {
    return this.active.get(slug) ?? null;
  }

  getJob(id: string): ConcatJob | null {
    return this.jobs.get(id) ?? null;
  }

  start(slug: string): ConcatJob {
    if (this.active.has(slug)) {
      throw new Error(`Concat déjà en cours sur '${slug}'`);
    }
    const project = getProject(slug);
    if (!project) throw new Error(`Projet inconnu: '${slug}'`);

    const clipsDir = path.join(project.outDir, "clips");
    if (!existsSync(clipsDir)) throw new Error(`clips/ introuvable pour '${slug}'`);

    const clips = readdirSync(clipsDir)
      .filter((f) => /\.(mp4|webm|mov)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (!clips.length) throw new Error("Aucun clip à concaténer");

    const id = randomBytes(6).toString("hex");
    const outPath = path.join(project.outDir, "master.mp4");
    const listPath = path.join(project.outDir, `.concat-list-${id}.txt`);

    mkdirSync(project.outDir, { recursive: true });
    const lines = clips.map((c) => {
      const abs = path.join(clipsDir, c).replace(/'/g, `'\\''`);
      return `file '${abs}'`;
    }).join("\n");
    writeFileSync(listPath, lines + "\n");

    const job: ConcatJob = {
      id,
      slug,
      startedAt: Date.now(),
      status: "running",
      clipsCount: clips.length,
      log: [],
    };
    this.jobs.set(id, job);
    this.active.set(slug, job);

    const args = [
      "-y", "-hide_banner", "-loglevel", "info",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30",
      "-c:v", "libx264", "-preset", "fast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ];

    const child = spawn("ffmpeg", args, { cwd: ROOT });
    this.children.set(id, child);

    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        job.log.push(line);
        if (job.log.length > 400) job.log.shift();
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      job.status = "error";
      job.error = err.message;
      job.endedAt = Date.now();
      this.cleanup(slug, id, listPath);
    });
    child.on("exit", (code) => {
      job.endedAt = Date.now();
      try {
        if (code === 0 && existsSync(outPath) && statSync(outPath).size > 0) {
          job.status = "done";
          job.outPath = outPath;
          job.outUrl = `/generated/${slug}/master.mp4?ts=${Date.now()}`;
        } else {
          job.status = "error";
          job.error = `ffmpeg exit ${code}`;
        }
      } catch (e) {
        job.status = "error";
        job.error = (e as Error).message;
      }
      this.cleanup(slug, id, listPath);
    });

    return job;
  }

  stop(slug: string): boolean {
    const job = this.active.get(slug);
    if (!job) return false;
    const child = this.children.get(job.id);
    if (!child) return false;
    try {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
      return true;
    } catch {
      return false;
    }
  }

  private cleanup(slug: string, id: string, listPath: string) {
    this.active.delete(slug);
    this.children.delete(id);
    try { if (existsSync(listPath)) unlinkSync(listPath); } catch {}
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __projectsConcatRunner: ConcatRunner | undefined;
}

export const concatRunner: ConcatRunner =
  globalThis.__projectsConcatRunner ?? (globalThis.__projectsConcatRunner = new ConcatRunner());
