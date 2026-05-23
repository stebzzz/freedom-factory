import { NextResponse } from "next/server";
import { deleteKit, getKit } from "@/lib/style-kit/import";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const kit = await getKit(slug);
  if (!kit) return NextResponse.json({ error: `kit '${slug}' inconnu` }, { status: 404 });
  return NextResponse.json({ kit });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await deleteKit(slug);
  return NextResponse.json({ ok: true });
}
