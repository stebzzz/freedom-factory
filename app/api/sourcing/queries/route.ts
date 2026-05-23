import { NextRequest, NextResponse } from "next/server";
import { generateSourcingQueries } from "@/lib/sourcing/claude";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { title?: string; hint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.title || body.title.trim().length < 3) {
    return NextResponse.json({ error: "title is required (min 3 chars)" }, { status: 400 });
  }
  try {
    const queries = await generateSourcingQueries(body.title.trim(), body.hint);
    return NextResponse.json({ queries });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
