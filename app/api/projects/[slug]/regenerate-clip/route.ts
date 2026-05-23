import { NextResponse } from "next/server";
import path from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { getProject } from "@/lib/projects/registry";
import { generateIngredientsClip, animateImage, generateT2VClip } from "@/lib/api/genaipro";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

interface RegenBody {
  sceneId: number;
  prompt: string;
  mode?: "t2v" | "i2v" | "ingredients"; // default ingredients
  referenceImagePath?: string;          // relative to project root or absolute
}

function slug2(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: `projet '${slug}' inconnu` }, { status: 404 });

  let body: RegenBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  if (typeof body.sceneId !== "number" || !body.prompt || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "Champs requis: sceneId (number), prompt (string)" }, { status: 400 });
  }

  const mode = body.mode ?? "ingredients";
  const projectRoot = process.cwd();
  const clipsDir = path.join(project.outDir, "clips");
  mkdirSync(clipsDir, { recursive: true });

  const stamp = Date.now();
  const fname = `${String(body.sceneId).padStart(2, "0")}_regen_${stamp}.mp4`;
  const outputPath = path.join(clipsDir, fname);

  try {
    if (mode === "ingredients") {
      const refPath = body.referenceImagePath
        ? (path.isAbsolute(body.referenceImagePath)
            ? body.referenceImagePath
            : path.join(projectRoot, body.referenceImagePath))
        : path.join(projectRoot, "public", "style-refs", "revolution_anchor.png");
      if (!existsSync(refPath)) {
        return NextResponse.json({ error: `Image de référence introuvable: ${refPath}` }, { status: 400 });
      }
      await generateIngredientsClip(body.prompt, [refPath], body.sceneId, outputPath);
    } else if (mode === "i2v") {
      // i2v requires an input image — we'd need a separate step to generate it. Skip for now.
      return NextResponse.json({ error: "Mode i2v non supporté ici — utilise ingredients ou t2v" }, { status: 400 });
    } else {
      // t2v
      await generateT2VClip(body.prompt, body.sceneId, outputPath);
    }
  } catch (err) {
    console.error(`[regenerate-clip] slug=${slug} scene=${body.sceneId}:`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  // Update manifest.json so the editor sees the new clip URL on next refresh.
  const manifestPath = path.join(project.outDir, "manifest.json");
  let manifest: { entries: Array<{ n?: number; id?: number; title?: string; video?: { taskId?: string; url?: string; path?: string } }> } = { entries: [] };
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); } catch { /* keep empty */ }
  }
  const idx = manifest.entries.findIndex((e) => (e.id === body.sceneId) || (e.n === body.sceneId));
  const entryUpdate = {
    n: body.sceneId,
    id: body.sceneId,
    video: { path: outputPath, url: `/generated/${slug}/clips/${fname}`, taskId: `regen_${stamp}` },
  };
  if (idx >= 0) manifest.entries[idx] = { ...manifest.entries[idx], ...entryUpdate };
  else manifest.entries.push(entryUpdate);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Update prompts.json so the modal can re-read the updated prompt next time.
  const promptsPath = path.join(project.outDir, "prompts.json");
  let prompts: Array<{ n: number; title?: string; prompt: string }> = [];
  if (existsSync(promptsPath)) {
    try {
      const data = JSON.parse(readFileSync(promptsPath, "utf-8"));
      if (Array.isArray(data)) prompts = data;
    } catch { /* keep empty */ }
  }
  const pidx = prompts.findIndex((p) => p.n === body.sceneId);
  if (pidx >= 0) prompts[pidx] = { ...prompts[pidx], prompt: body.prompt };
  else prompts.push({ n: body.sceneId, prompt: body.prompt });
  writeFileSync(promptsPath, JSON.stringify(prompts, null, 2));

  const publicUrl = `/generated/${slug}/clips/${fname}`;
  return NextResponse.json({ outputUrl: publicUrl, outputPath, sceneId: body.sceneId });
  void slug2; // helper retained for future per-title slugs
}
