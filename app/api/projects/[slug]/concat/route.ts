import { NextResponse } from "next/server";
import { concatRunner } from "@/lib/projects/concat";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const job = concatRunner.start(slug);
    return NextResponse.json({ jobId: job.id, clipsCount: job.clipsCount, startedAt: job.startedAt });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (jobId) {
    const job = concatRunner.getJob(jobId);
    if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
    return NextResponse.json({ job });
  }
  return NextResponse.json({ active: concatRunner.getActive(slug) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ok = concatRunner.stop(slug);
  return NextResponse.json({ ok });
}
