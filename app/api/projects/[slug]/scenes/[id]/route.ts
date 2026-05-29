import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getScene, patchScenePrompt } from "@/lib/projects/state";
import { getProject } from "@/lib/projects/registry";
import { multiRunner } from "@/lib/projects/runner";
import { generateImages as generateImagesGenAIPro } from "@/lib/api/genaipro";
import { generateImages as generateImagesGeminigen } from "@/lib/api/geminigen";
import { generateImages as generateImagesWan } from "@/lib/api/wan";
import { generateImages as generateImagesFlowmax } from "@/lib/api/flowmax";
import type { ImageResult } from "@/lib/pipeline/types";
import type { RunMode } from "@/lib/projects/types";

type ImageProvider = "genaipro" | "geminigen" | "wan" | "flowmax";
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

/** Per-scene reference resolver from refs-mapping.json — keeps a regenerated
 *  image consistent with the style/character refs the pipeline picked for it. */
function buildRefsResolver(outDir: string): ((idx: number) => Promise<string[]>) | undefined {
  const p = path.join(outDir, "refs-mapping.json");
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as {
      scenes?: Array<{ sceneIndex: number; refs?: Array<{ url: string }> }>;
    };
    const publicDir = path.join(process.cwd(), "public");
    const map = new Map<number, string[]>();
    for (const row of data.scenes ?? []) {
      const paths = (row.refs ?? [])
        .map((r) => (r.url.startsWith("/") ? path.join(publicDir, r.url.slice(1)) : r.url))
        .filter((fp) => fp && existsSync(fp));
      if (paths.length) map.set(row.sceneIndex, paths);
    }
    if (map.size === 0) return undefined;
    return async (idx: number) => map.get(idx) ?? [];
  } catch {
    return undefined;
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
            : provider === "flowmax" ? generateImagesFlowmax
              : generateImagesGenAIPro) as unknown as ImagesFn;
      const modelOpt =
        provider === "geminigen" ? { model: meta.geminigenModel ?? "nano-banana-2" }
          : provider === "wan" ? { model: meta.wanModel ?? "wan2.7-image" }
            : {};

      // generateImages doesn't throw on per-scene failures — it calls onImageFailed
      // and returns whatever scenes succeeded. Capture the failure reason so the
      // route can return a real error instead of pretending the regen worked.
      let failureReason: string | null = null;
      const resolveRefsForScene = buildRefsResolver(project!.outDir);
      const results = await generateImages(
        [{ index: sceneId, imagePrompt: prompt }],
        imagesDir,
        () => {},
        {
          concurrency: 1,
          ...modelOpt,
          ...(resolveRefsForScene ? { resolveRefsForScene } : {}),
          onImageFailed: (_idx: number, reason: string) => {
            failureReason = reason;
          },
        },
      );
      // wan.generateImages pushes a placeholder ImageResult even on failure, so we
      // can't trust the array — verify the actual file landed on disk before claiming success.
      // Providers differ on extension (FlowMax → .jpg, others → .png), so probe both.
      const padded = String(sceneId).padStart(3, "0");
      const finalExt = ["png", "jpg", "jpeg", "webp"].find((ext) =>
        existsSync(path.join(imagesDir, `scene_${padded}.${ext}`)),
      );
      const finalPath = finalExt ? path.join(imagesDir, `scene_${padded}.${finalExt}`) : "";
      const got = results.find((r) => r.sceneIndex === sceneId);
      if (!got || !finalExt || failureReason) {
        const msg = failureReason ?? `image regen via ${provider}: pas de fichier généré`;
        const hint = /401|invalid_token|jwt/i.test(msg)
          ? ` — la clé ${provider} est probablement expirée (JWT Clerk pour GenAIPro), mets-la à jour dans /settings`
          : /IPInfringement|infringement|copyright|trademark/i.test(msg)
            ? " — DashScope a détecté du contenu protégé (IP/marque/personnage connu). Essaie 'Rewrite from VO' pour produire un prompt générique."
            : /DataInspectionFailed|inappropriate|safety/i.test(msg)
              ? " — DashScope a bloqué pour cause de modération. Essaie 'Rewrite from VO'."
              : "";
        return NextResponse.json({ ok: false, error: `[${provider}] ${msg}${hint}` }, { status: 502 });
      }
      const url = `/generated/${slug}/images/scene_${padded}.${finalExt}`;
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
