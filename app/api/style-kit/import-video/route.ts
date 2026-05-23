import { NextResponse } from "next/server";
import { importFromYouTube } from "@/lib/style-kit/import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Frame extraction + ~10 Haiku Vision calls + 1 Sonnet consolidation can run 60-120s.
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { url?: string; slug?: string; cadenceSeconds?: number; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }

  const url = body.url?.trim() ?? "";
  const slug = body.slug?.trim() ?? "";
  if (!url) return NextResponse.json({ error: "url requise" }, { status: 400 });
  if (!slug) return NextResponse.json({ error: "slug requis" }, { status: 400 });

  // Default 3s = matches the typical "Sleepy / explainer" cadence the user gave.
  const cadenceSeconds = Math.min(Math.max(body.cadenceSeconds ?? 3, 0.5), 60);
  const mode = body.mode === "describe" ? "describe" : "classify";

  try {
    const meta = await importFromYouTube(url, slug, cadenceSeconds, mode);
    return NextResponse.json({ kit: meta });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[style-kit/import-video]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
