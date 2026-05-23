import { NextResponse } from "next/server";
import { getKit } from "@/lib/style-kit/import";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const kit = await getKit(slug);
  if (!kit) return NextResponse.json({ error: `kit '${slug}' inconnu` }, { status: 404 });

  const url = new URL(req.url);
  const download = url.searchParams.get("download") === "1";

  const images = [...kit.character, ...kit.style]
    .filter((img) => (img.imagePrompt ?? "").trim().length > 0)
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((img) => ({
      filename: img.filename,
      url: img.url,
      imagePrompt: img.imagePrompt,
    }));

  const payload = {
    slug: kit.slug,
    mode: kit.mode ?? "classify",
    source: kit.sourceUrl ? "youtube" : kit.sourcePdf ? "pdf" : "unknown",
    sourceUrl: kit.sourceUrl,
    sourcePdf: kit.sourcePdf,
    createdAt: kit.createdAt,
    count: images.length,
    images,
  };

  const body = JSON.stringify(payload, null, 2);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (download) {
    headers["content-disposition"] = `attachment; filename="${slug}-prompts.json"`;
  }
  return new Response(body, { headers });
}
