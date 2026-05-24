import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { getScene, patchScenePrompt } from "@/lib/projects/state";
import { getProject } from "@/lib/projects/registry";
import { multiRunner } from "@/lib/projects/runner";
import { generateImages } from "@/lib/api/genaipro";
import type { RunMode } from "@/lib/projects/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const scene = getScene(slug, parseInt(id, 10));
  if (!scene) return NextResponse.json({ error: "scène introuvable" }, { status: 404 });
  return NextResponse.json({ scene });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const sceneId = parseInt(id, 10);
  if (Number.isNaN(sceneId)) return NextResponse.json({ error: "id invalide" }, { status: 400 });

  let body: { videoPrompt?: string; imagePrompt?: string; vo?: string; title?: string; regen?: boolean; mode?: RunMode };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const result = patchScenePrompt(slug, sceneId, {
    videoPrompt: body.videoPrompt,
    imagePrompt: body.imagePrompt,
    vo: body.vo,
    title: body.title,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  if (!body.regen) return NextResponse.json({ ok: true });

  // Pipeline jobs (script.json present) have no associated CLI script, so multiRunner
  // bails out. For image regen, call generateImages inline using the freshly-patched prompt.
  const project = getProject(slug);
  const isPipelineJob = project && existsSync(path.join(project.outDir, "script.json"));
  if (isPipelineJob && body.mode === "scene-regen-image") {
    const prompt = (body.imagePrompt ?? "").trim();
    if (!prompt) {
      return NextResponse.json({ ok: true, regenError: "imagePrompt vide — édite le prompt avant regen" }, { status: 200 });
    }
    try {
      const imagesDir = path.join(project!.outDir, "images");
      await generateImages(
        [{ index: sceneId, imagePrompt: prompt }],
        imagesDir,
        () => {},
        { concurrency: 1 },
      );
      const url = `/generated/${slug}/images/scene_${String(sceneId).padStart(3, "0")}.png`;
      return NextResponse.json({ ok: true, imageUrl: url });
    } catch (err) {
      return NextResponse.json({ ok: true, regenError: `image regen: ${(err as Error).message}` }, { status: 200 });
    }
  }

  // Legacy CLI projects: spawn the project's regen script via multiRunner.
  try {
    const mode: RunMode = body.mode ?? "regen-ids";
    const runInfo = multiRunner.start(slug, mode, { ids: [sceneId], force: true });
    return NextResponse.json({ ok: true, runInfo });
  } catch (err) {
    return NextResponse.json({ ok: true, regenError: (err as Error).message }, { status: 200 });
  }
}
