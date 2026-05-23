import { NextResponse } from "next/server";
import { multiRunner } from "@/lib/projects/runner";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? undefined;
  return NextResponse.json({
    active: multiRunner.getActive(slug),
    log: multiRunner.getLog(slug, runId),
    recent: multiRunner.listRecent(slug, 10),
  });
}
