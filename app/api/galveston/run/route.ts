import { NextRequest, NextResponse } from "next/server";
import { runner, RunMode } from "@/lib/galveston/runner";

export const dynamic = "force-dynamic";

const VALID_MODES: RunMode[] = [
  "rolling", "images-only", "videos-only", "resume",
  "failed-only", "stuck-only",
  "scene-regen-image", "scene-regen-video", "scene-generate-video",
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { action: "start" | "stop"; mode?: RunMode; ids?: number[]; force?: boolean };
    if (body.action === "stop") {
      const ok = runner.stop();
      return NextResponse.json({ ok });
    }
    if (body.action !== "start") {
      return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
    }
    const mode = body.mode ?? "rolling";
    if (!VALID_MODES.includes(mode)) return NextResponse.json({ error: `unknown mode '${mode}'` }, { status: 400 });
    const info = runner.start(mode, { ids: body.ids, force: body.force });
    return NextResponse.json({ runId: info.id, mode: info.mode, ids: info.ids });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}

export async function GET() {
  return NextResponse.json({
    active: runner.getActive(),
    recent: runner.listRecent(5),
  });
}
