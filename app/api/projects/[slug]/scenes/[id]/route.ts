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
  // bails out. The drawer's main "Regen" button defaults to mode "regen-ids", so we
  // treat regen-ids / ids-only / scene-regen-image all as image regen for pipeline jobs.
  // (scene-regen-video has its own dedicated /regenerate-clip route.)
  const project = getProject(slug);
  const isPipelineJob = project && existsSync(path.join(project.outDir, "script.json"));
  const imageRegenModes = new Set<string>(["scene-regen-image", "regen-ids", "ids-only"]);
  if (isPipelineJob && (!body.mode || imageRegenModes.has(body.mode))) {
    const prompt = (body.imagePrompt ?? "").trim();
    if (!prompt) {
      return NextResponse.json({ ok: true, regenError: "imagePrompt vide — édite le prompt avant regen" }, { status: 200 });
    }
    try {
      const imagesDir = path.join(project!.outDir, "images");
      // generateImages doesn't throw on per-scene failures — it calls onImageFailed
      // and returns whatever scenes succeeded. Capture the failure reason so the
      // route can return a real error instead of pretending the regen worked.
      let failureReason: string | null = null;
      const results = await generateImages(
        [{ index: sceneId, imagePrompt: prompt }],
        imagesDir,
        () => {},
        {
          concurrency: 1,
          onImageFailed: (_idx, reason) => {
            failureReason = reason;
          },
        },
      );
      const got = results.find((r) => r.sceneIndex === sceneId);
      if (!got) {
        const msg = failureReason ?? "image regen: generateImages n'a rien retourné";
        // 401 from Veo3 means the GenAIPro JWT Clerk token has expired.
        const hint = /401|invalid_token|jwt/i.test(msg)
          ? " — la clé GenAIPro est probablement un JWT Clerk expiré, mets-la à jour dans /settings"
          : "";
        return NextResponse.json({ ok: false, error: msg + hint }, { status: 502 });
      }
      const url = `/generated/${slug}/images/scene_${String(sceneId).padStart(3, "0")}.png`;
      return NextResponse.json({ ok: true, imageUrl: url });
    } catch (err) {
      return NextResponse.json({ ok: false, error: `image regen: ${(err as Error).message}` }, { status: 500 });
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
