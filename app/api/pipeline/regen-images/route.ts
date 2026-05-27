// Régénération ciblée d'images d'un job pipeline (par sceneIndex), via le bon
// provider + refs du style kit (refs-mapping.json). Utilisé par le bouton manuel.
import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getJob } from "@/lib/pipeline/runner";
import { generateImages as genGenAIPro } from "@/lib/api/genaipro";
import { generateImages as genGeminigen } from "@/lib/api/geminigen";
import { generateImages as genWan } from "@/lib/api/wan";
import { generateImages as genFlowmax } from "@/lib/api/flowmax";
import type { ImageResult } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

type ImageProvider = "genaipro" | "geminigen" | "wan";
type ImagesFn = (
  scenes: { index: number; imagePrompt: string }[],
  outDir: string,
  onProgress: (done: number, total: number) => void,
  opts?: Record<string, unknown>,
) => Promise<ImageResult[]>;

// Reconstruit le résolveur de refs par scène depuis refs-mapping.json (sinon la
// regen perd le style/personnage du kit). Renvoie undefined si pas de mapping.
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

function urlFor(imagePath: string): string {
  const i = imagePath.indexOf("/generated/");
  return i === -1 ? imagePath : imagePath.slice(i);
}

export async function POST(req: NextRequest) {
  let body: { jobId?: string; sceneIndices?: number[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const jobId = body.jobId;
  if (!jobId) return NextResponse.json({ error: "jobId requis" }, { status: 400 });
  const indices = Array.isArray(body.sceneIndices)
    ? [...new Set(body.sceneIndices.filter((n) => Number.isInteger(n)))]
    : [];
  if (indices.length === 0) return NextResponse.json({ error: "aucune scène fournie" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job introuvable en mémoire (serveur redémarré ?)" }, { status: 404 });

  const imgs = job.result.images ?? [];
  const byIdx = new Map(imgs.map((im) => [im.sceneIndex, im]));
  const targets: { index: number; imagePrompt: string }[] = [];
  for (const idx of indices) {
    const im = byIdx.get(idx);
    const prompt = (im?.prompt ?? "").trim();
    if (prompt) targets.push({ index: idx, imagePrompt: prompt });
  }
  if (targets.length === 0) {
    return NextResponse.json({ error: "aucune scène avec un prompt valide" }, { status: 400 });
  }

  const provider: ImageProvider = (job.params.imageProvider as ImageProvider) ?? "genaipro";
  const generateImages: ImagesFn =
    (provider === "geminigen" ? genGeminigen
      : provider === "wan" ? genWan
      : provider === "flowmax" ? genFlowmax
      : genGenAIPro) as unknown as ImagesFn;
  const modelOpt =
    provider === "geminigen" ? { model: job.params.geminigenModel ?? "nano-banana-2" }
    : provider === "wan" ? { model: job.params.wanModel ?? "wan2.7-image" }
    : {};
  const ext = provider === "geminigen" || provider === "flowmax" ? "jpg" : "png";

  const jobDir = path.join(process.cwd(), "public", "generated", jobId);
  const imagesDir = path.join(jobDir, "images");
  const resolveRefsForScene = buildRefsResolver(jobDir);
  const failures = new Map<number, string>();

  try {
    await generateImages(targets, imagesDir, () => {}, {
      concurrency: 3,
      ...modelOpt,
      ...(resolveRefsForScene ? { resolveRefsForScene } : {}),
      onImageFailed: (idx: number, reason: string) => failures.set(idx, reason),
    });
  } catch (err) {
    return NextResponse.json({ error: `regen: ${(err as Error).message}` }, { status: 500 });
  }

  const stamp = Date.now();
  const results = targets.map((t) => {
    const finalPath = path.join(imagesDir, `scene_${String(t.index).padStart(3, "0")}.${ext}`);
    const ok = existsSync(finalPath) && !failures.has(t.index);
    if (ok) {
      byIdx.set(t.index, { sceneIndex: t.index, imagePath: finalPath, prompt: t.imagePrompt });
    }
    return {
      sceneIndex: t.index,
      ok,
      url: ok ? `${urlFor(finalPath)}?t=${stamp}` : undefined,
      error: ok ? undefined : failures.get(t.index) ?? "pas de fichier généré",
    };
  });

  // Met à jour le job en mémoire pour que le montage / l'UI reflètent les nouvelles images.
  job.result.images = [...byIdx.values()].sort((a, b) => a.sceneIndex - b.sceneIndex);

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: okCount > 0,
    provider,
    requested: indices.length,
    regenerated: okCount,
    failed: results.length - okCount,
    results,
  });
}
