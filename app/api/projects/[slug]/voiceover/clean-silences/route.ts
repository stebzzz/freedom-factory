// Strip / cap silences in the project's voiceover.wav via the existing
// scripts/remove-silences-clean.mjs (2-pass silencedetect + atrim + fade,
// no audible clicks). Original file is backed up to voiceover.original.wav
// the first time around so the user can revert.
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

interface Body {
  threshold?: string;    // e.g. "-35dB"
  min?: number;          // min silence duration to cut (seconds)
  pad?: number;          // breath kept around each speech segment
  fade?: number;         // micro crossfade at each cut
}

function runScript(scriptPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (e) => reject(e));
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`remove-silences-clean exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  const vo = path.join(project.outDir, "voiceover.wav");
  if (!existsSync(vo)) {
    return NextResponse.json({ error: "voiceover.wav absent — uploade d'abord une VO" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const threshold = body.threshold ?? "-35dB";
  const min = body.min ?? 0.4;
  const pad = body.pad ?? 0.08;
  const fade = body.fade ?? 0.02;

  const projectRoot = process.cwd();
  const scriptPath = path.join(projectRoot, "scripts", "remove-silences-clean.mjs");
  if (!existsSync(scriptPath)) {
    return NextResponse.json({ error: `script introuvable: ${scriptPath}` }, { status: 500 });
  }

  // Back up the ORIGINAL voiceover the first time we touch it, so the user can
  // restore via /voiceover (POST file=original) if the silence-strip is too aggressive.
  const backup = path.join(project.outDir, "voiceover.original.wav");
  if (!existsSync(backup)) {
    await copyFile(vo, backup);
  }

  // Write the cleaned output to a temp path next door, then atomically replace voiceover.wav.
  const tmpOut = path.join(project.outDir, "voiceover.cleaned.wav");
  const sizeBefore = (await stat(vo)).size;
  const durBefore = await probeDuration(vo);

  try {
    await runScript(scriptPath, [
      vo,
      tmpOut,
      `--threshold=${threshold}`,
      `--min=${min}`,
      `--pad=${pad}`,
      `--fade=${fade}`,
    ]);
  } catch (err) {
    if (existsSync(tmpOut)) await unlink(tmpOut).catch(() => {});
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const sizeAfter = (await stat(tmpOut)).size;
  const durAfter = await probeDuration(tmpOut);
  await rename(tmpOut, vo);

  return NextResponse.json({
    ok: true,
    backupCreated: !existsSync(backup) ? false : true,
    before: { sizeBytes: sizeBefore, durationSec: durBefore },
    after: { sizeBytes: sizeAfter, durationSec: durAfter },
    removedSec: Math.max(0, durBefore - durAfter),
    params: { threshold, min, pad, fade },
  });
}

async function probeDuration(p: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      p,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.on("close", () => resolve(parseFloat(out.trim()) || 0));
  });
}
