// Batch image regeneration. Takes a list of scene ids and regenerates all of
// their images in one call, using the image provider's native concurrency
// (Wan defaults to 3-wide) — far faster and less fiddly than firing N separate
// /scenes/[id] PATCH requests from the browser.
import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";
import { generateImages as generateImagesGenAIPro } from "@/lib/api/genaipro";
import { generateImages as generateImagesGeminigen } from "@/lib/api/geminigen";
import { generateImages as generateImagesWan } from "@/lib/api/wan";
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

interface ScriptScene {
  index: number;
  imagePrompt?: string;
}
interface ScriptMeta {
  imageProvider?: ImageProvider;
  wanModel?: string;
  geminigenModel?: string;
  scenes?: ScriptScene[];
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  // Accepts either { ids: [...] } or { ids, prompts: { "<id>": "edited prompt" } }.
  // When prompts are supplied (from the batch review modal), they're persisted to
  // script.json before regeneration so the new image uses the edited prompt and
  // the edit sticks for future runs.
  let body: { ids?: number[]; prompts?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((n) => Number.isInteger(n)))] : [];
  if (ids.length === 0) return NextResponse.json({ error: "aucun id fourni" }, { status: 400 });

  const scriptPath = path.join(project.outDir, "script.json");
  if (!existsSync(scriptPath)) {
    return NextResponse.json({ error: "script.json absent — ce projet n'est pas un job pipeline" }, { status: 400 });
  }
  let meta: ScriptMeta;
  try {
    meta = JSON.parse(readFileSync(scriptPath, "utf-8")) as ScriptMeta;
  } catch {
    return NextResponse.json({ error: "script.json illisible" }, { status: 500 });
  }

  // Persist any edited prompts into script.json (single backup, single write).
  const prompts = body.prompts ?? {};
  const editedIds = Object.keys(prompts).map((k) => parseInt(k, 10)).filter((n) => Number.isInteger(n));
  if (editedIds.length > 0 && Array.isArray(meta.scenes)) {
    let changed = false;
    for (const sc of meta.scenes) {
      const edit = prompts[String(sc.index)];
      if (typeof edit === "string" && edit.trim() && edit !== sc.imagePrompt) {
        sc.imagePrompt = edit.trim();
        changed = true;
      }
    }
    if (changed) {
      try {
        copyFileSync(scriptPath, scriptPath.replace(/\.json$/, `.backup-${Date.now()}.json`));
        writeFileSync(scriptPath, JSON.stringify(meta, null, 2));
      } catch (e) {
        return NextResponse.json({ error: `écriture script.json: ${(e as Error).message}` }, { status: 500 });
      }
    }
  }

  const byIndex = new Map((meta.scenes ?? []).map((s) => [s.index, s]));
  const targets: { index: number; imagePrompt: string }[] = [];
  const skipped: { id: number; reason: string }[] = [];
  for (const id of ids) {
    const sc = byIndex.get(id);
    const prompt = (sc?.imagePrompt ?? "").trim();
    if (!prompt) skipped.push({ id, reason: "imagePrompt vide" });
    else targets.push({ index: id, imagePrompt: prompt });
  }
  if (targets.length === 0) {
    return NextResponse.json({ ok: false, error: "aucune scène avec un imagePrompt valide", skipped }, { status: 400 });
  }

  const provider: ImageProvider = meta.imageProvider ?? "wan";
  const generateImages: ImagesFn =
    (provider === "geminigen" ? generateImagesGeminigen
      : provider === "wan" ? generateImagesWan
        : generateImagesGenAIPro) as unknown as ImagesFn;
  const modelOpt =
    provider === "geminigen" ? { model: meta.geminigenModel ?? "nano-banana-2" }
      : provider === "wan" ? { model: meta.wanModel ?? "wan2.7-image" }
        : {};

  const imagesDir = path.join(project.outDir, "images");
  const failures = new Map<number, string>();
  try {
    await generateImages(targets, imagesDir, () => {}, {
      concurrency: 3,
      ...modelOpt,
      onImageFailed: (idx: number, reason: string) => failures.set(idx, reason),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `batch regen: ${(err as Error).message}` }, { status: 500 });
  }

  // Verify each target landed on disk — wan pushes placeholders even on failure.
  const results = targets.map((t) => {
    const finalPath = path.join(imagesDir, `scene_${String(t.index).padStart(3, "0")}.png`);
    const ok = existsSync(finalPath) && !failures.has(t.index);
    return { id: t.index, ok, error: ok ? undefined : (failures.get(t.index) ?? "pas de fichier généré") };
  });

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: okCount > 0,
    provider,
    requested: ids.length,
    regenerated: okCount,
    failed: results.length - okCount,
    results,
    skipped,
  });
}
