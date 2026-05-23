import { NextResponse } from "next/server";
import { loadPack } from "@/lib/sourcing/pack";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const pack = loadPack(slug);
  if (!pack) return NextResponse.json({ error: "pack introuvable" }, { status: 404 });
  return NextResponse.json({ pack });
}
