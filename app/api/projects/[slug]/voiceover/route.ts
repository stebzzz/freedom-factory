// Upload (or delete) a manual voice-over file for a pipeline job.
// Written as voiceover.wav in the job's outDir so the finalize route picks it up.
import { NextRequest, NextResponse } from "next/server";
import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const ALLOWED_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "champ 'file' manquant (multipart/form-data)" }, { status: 400 });
  }

  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: `extension '${ext}' non supportée (wav/mp3/m4a/aac/ogg/flac)` }, { status: 400 });
  }

  // Always land at voiceover.wav so the rest of the pipeline finds it. ffmpeg downstream
  // accepts any of these containers under the .wav filename — fluent-ffmpeg probes content.
  const out = path.join(project.outDir, "voiceover.wav");
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(out, buf);
  return NextResponse.json({ ok: true, path: out, sizeBytes: buf.length });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });
  const p = path.join(project.outDir, "voiceover.wav");
  if (existsSync(p)) await unlink(p);
  return NextResponse.json({ ok: true });
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });
  const p = path.join(project.outDir, "voiceover.wav");
  return NextResponse.json({ exists: existsSync(p) });
}
