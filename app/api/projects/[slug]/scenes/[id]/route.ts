import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getScene, patchScenePrompt } from "@/lib/projects/state";
import { getProject } from "@/lib/projects/registry";
import { multiRunner } from "@/lib/projects/runner";
import { generateImages as generateImagesGenAIPro } from "@/lib/api/genaipro";
import { generateImages as generateImagesGeminigen } from "@/lib/api/geminigen";
import { generateImages as generateImagesWan } from "@/lib/api/wan";
import type { ImageResult } from "@/lib/pipeline/types";
import type { RunMode } from "@/lib/projects/types";

type ImageProvider = "genaipro" | "geminigen" | "wan";
type ImagesFn = (
  scenes: { index: number; imagePrompt: string }[],
  outDir: string,
  onProgress: (done: number, total: number) => void,
  opts?: Record<string, unknown>,
) => Promise<ImageResult[]>;

function readScriptMeta(outDir: string): {
  imageProvider?: ImageProvider;
  wanModel?: string;
  geminigenModel?: string;
} {
  const p = path.join(outDir, "script.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ReturnType<typeof readScriptMeta>;
  } catch {
    return {};
  }
}

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
      // Pick the provider that generated the original image — stored in script.json
      // at job creation. Fallback to "wan" for legacy jobs that predate persistence
      // (covers the current user's flow; genaipro is opt-in and its JWT expires).
      const meta = readScriptMeta(project!.outDir);
      const provider: ImageProvider = meta.imageProvider ?? "wan";
      const generateImages: ImagesFn =
        (provider === "geminigen" ? generateImagesGeminigen
          : provider === "wan" ? generateImagesWan
            : generateImagesGenAIPro) as unknown as ImagesFn;
      const modelOpt =
        provider === "geminigen" ? { model: meta.geminigenModel ?? "nano-banana-2" }
          : provider === "wan" ? { model: meta.wanModel ?? "wan2.7-image" }
            : {};

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
          ...modelOpt,
          onImageFailed: (_idx: number, reason: string) => {
            failureReason = reason;
          },
        },
      );
      const got = results.find((r) => r.sceneIndex === sceneId);
      if (!got) {
        const msg = failureReason ?? `image regen via ${provider}: aucun résultat`;
        const hint = /401|invalid_token|jwt/i.test(msg)
          ? ` — la clé ${provider} est probablement expirée (JWT Clerk pour GenAIPro), mets-la à jour dans /settings`
          : "";
        return NextResponse.json({ ok: false, error: `[${provider}] ${msg}${hint}` }, { status: 502 });
      }
      const url = `/generated/${slug}/images/scene_${String(sceneId).padStart(3, "0")}.png`;
      return NextResponse.json({ ok: true, imageUrl: url, provider });
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
