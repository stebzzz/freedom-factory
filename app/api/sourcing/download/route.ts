import { NextRequest, NextResponse } from "next/server";
import { downloadAssets } from "@/lib/sourcing/pack";
import type { DownloadTarget, SourcingAsset } from "@/lib/sourcing/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: { target: DownloadTarget; assets: SourcingAsset[]; title?: string; queries?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.target?.type || !body.target.slug) {
    return NextResponse.json({ error: "target.type and target.slug required" }, { status: 400 });
  }
  if (!Array.isArray(body.assets) || body.assets.length === 0) {
    return NextResponse.json({ error: "assets[] required" }, { status: 400 });
  }
  try {
    const result = await downloadAssets(body.target, body.assets, {
      title: body.title,
      queries: body.queries,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
