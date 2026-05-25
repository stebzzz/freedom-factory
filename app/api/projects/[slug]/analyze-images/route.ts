// Image QC analysis via Claude Vision.
//   POST → start a background analysis run (idempotent: 409 if already running)
//   GET  → poll current state (status, done/total, flagged scenes)
import { NextResponse } from "next/server";
import { getAnalysis, startAnalysis } from "@/lib/projects/imageAnalysis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = getAnalysis(slug);
  if (!state) return NextResponse.json({ status: "none" });
  return NextResponse.json(state);
}

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const res = startAnalysis(slug);
  if (!res.ok) {
    const code = res.error === "projet inconnu" ? 404 : res.state ? 409 : 400;
    return NextResponse.json({ error: res.error, state: res.state }, { status: code });
  }
  return NextResponse.json({ ok: true, state: res.state });
}
