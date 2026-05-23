import { NextResponse } from "next/server";
import { retagImage } from "@/lib/style-kit/import";
import type { KitTag } from "@/lib/style-kit/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let body: { filename?: string; tag?: KitTag };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  if (!body.filename || (body.tag !== "character" && body.tag !== "style")) {
    return NextResponse.json({ error: "filename + tag (character|style) requis" }, { status: 400 });
  }
  try {
    const kit = await retagImage(slug, body.filename, body.tag);
    return NextResponse.json({ kit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
