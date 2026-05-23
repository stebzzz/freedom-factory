import { NextRequest, NextResponse } from "next/server";
import { getScene, patchScenePrompt } from "@/lib/projects/state";
import { multiRunner } from "@/lib/projects/runner";
import type { RunMode } from "@/lib/projects/types";

export const dynamic = "force-dynamic";

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

  let runInfo = null;
  if (body.regen) {
    try {
      const mode: RunMode = body.mode ?? "regen-ids";
      runInfo = multiRunner.start(slug, mode, { ids: [sceneId], force: true });
    } catch (err) {
      return NextResponse.json({ ok: true, regenError: (err as Error).message }, { status: 200 });
    }
  }
  return NextResponse.json({ ok: true, runInfo });
}
