import { NextResponse } from "next/server";
import { listPacks } from "@/lib/sourcing/pack";

export const dynamic = "force-dynamic";

export async function GET() {
  const packs = listPacks().map((p) => ({
    slug: p.slug,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    queries: p.queries,
    attachedProject: p.attachedProject,
    assetCount: p.assets.length,
    imageCount: p.assets.filter((a) => a.kind === "image").length,
    videoCount: p.assets.filter((a) => a.kind === "video").length,
  }));
  return NextResponse.json({ packs });
}
