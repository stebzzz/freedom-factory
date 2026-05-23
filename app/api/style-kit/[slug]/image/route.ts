import { NextResponse } from "next/server";
import { deleteImage } from "@/lib/style-kit/import";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const filename = url.searchParams.get("filename") ?? "";
  if (!filename) return NextResponse.json({ error: "filename query requis" }, { status: 400 });
  try {
    const kit = await deleteImage(slug, filename);
    return NextResponse.json({ kit });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
