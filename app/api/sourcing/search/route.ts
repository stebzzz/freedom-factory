import { NextRequest, NextResponse } from "next/server";
import { multiQuerySearch } from "@/lib/sourcing/aggregator";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { queries?: string[]; title?: string; rankWithClaude?: boolean; topN?: number; imagesPerQuery?: number; videosPerQuery?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const queries = (body.queries ?? []).map((q) => q.trim()).filter(Boolean);
  if (queries.length === 0) {
    return NextResponse.json({ error: "queries[] is required" }, { status: 400 });
  }
  try {
    const result = await multiQuerySearch(queries, {
      title: body.title,
      rankWithClaude: body.rankWithClaude !== false && !!body.title,
      topN: body.topN ?? 60,
      imagesPerQuery: body.imagesPerQuery ?? 8,
      videosPerQuery: body.videosPerQuery ?? 6,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
