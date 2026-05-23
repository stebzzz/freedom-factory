import { NextRequest, NextResponse } from "next/server";
import { multiRunner } from "@/lib/projects/runner";
import type { RunMode } from "@/lib/projects/types";

export const dynamic = "force-dynamic";

const VALID_MODES: RunMode[] = [
  "rolling",
  "resume",
  "failed-only",
  "stuck-only",
  "regen-ids",
  "ids-only",
  "scene-regen-image",
  "scene-regen-video",
];

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let body: { mode?: RunMode; ids?: number[]; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const mode = body.mode ?? "rolling";
  if (!VALID_MODES.includes(mode)) {
    return NextResponse.json({ error: `mode invalide: '${mode}'` }, { status: 400 });
  }
  try {
    const info = multiRunner.start(slug, mode, { ids: body.ids, force: body.force });
    return NextResponse.json({ runId: info.id, mode: info.mode, ids: info.ids, startedAt: info.startedAt });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
