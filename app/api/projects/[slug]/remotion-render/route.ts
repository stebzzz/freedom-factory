import { NextResponse } from "next/server";
import path from "path";
import { mkdir } from "fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { loadProjectState } from "@/lib/projects/state";
import type { MontageCompositionProps } from "@/remotion/types";

export const dynamic = "force-dynamic";
// Bundle + render is heavy — node runtime, no edge.
export const runtime = "nodejs";
// Allow up to 10 minutes for a long montage render.
export const maxDuration = 600;

// We cache the bundle across requests in dev to avoid the ~30s webpack pass
// on every render. In production it would also benefit, though Next.js may
// reload the module on changes.
let cachedServeUrl: string | null = null;

async function getServeUrl(): Promise<string> {
  if (cachedServeUrl) return cachedServeUrl;
  const entry = path.resolve(process.cwd(), "remotion", "index.ts");
  cachedServeUrl = await bundle({
    entryPoint: entry,
    onProgress: (p) => console.log(`[remotion-bundle] ${p}%`),
    // The default webpackOverride is fine — tailwind/aliases aren't required for the composition.
  });
  return cachedServeUrl;
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = loadProjectState(slug);
  if (!state) return NextResponse.json({ error: `projet '${slug}' inconnu` }, { status: 404 });

  let body: { composition?: MontageCompositionProps };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  if (!body.composition || !Array.isArray(body.composition.clips) || body.composition.clips.length === 0) {
    return NextResponse.json({ error: "composition.clips manquant ou vide" }, { status: 400 });
  }

  // The Remotion bundle expects clip URLs to be loadable. Inside the bundled
  // renderer, /generated/... paths aren't directly served — we need either
  // absolute file:// paths or web URLs. For local files we map relative paths
  // back to absolute file:// URLs.
  const projectRoot = process.cwd();
  const clips = body.composition.clips.map((c) => {
    if (/^(https?:|file:)/.test(c.url)) return c;
    const cleaned = c.url.startsWith("/") ? c.url.slice(1) : c.url;
    const abs = path.join(projectRoot, "public", cleaned);
    return { ...c, url: `file://${abs}` };
  });
  const compositionProps: MontageCompositionProps = { ...body.composition, clips };

  const outDir = path.join(projectRoot, "public", "generated", slug, "remotion");
  await mkdir(outDir, { recursive: true });
  const stamp = `${Date.now()}`;
  const outputPath = path.join(outDir, `remotion_${stamp}.mp4`);

  try {
    const serveUrl = await getServeUrl();
    const inputProps = compositionProps as unknown as Record<string, unknown>;
    const composition = await selectComposition({
      serveUrl,
      id: "Montage",
      inputProps,
    });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        if (Math.round(progress * 100) % 10 === 0) console.log(`[remotion-render] ${Math.round(progress * 100)}%`);
      },
    });
  } catch (err) {
    console.error("[remotion-render] échec:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const publicUrl = `/generated/${slug}/remotion/remotion_${stamp}.mp4`;
  return NextResponse.json({ outputUrl: publicUrl, outputPath });
}
