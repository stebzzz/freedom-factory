import { NextRequest, NextResponse } from "next/server";
import { runner, RunMode } from "@/lib/galveston/runner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { id: number; action: "regen-image" | "regen-video" | "generate-video"; force?: boolean };
    if (typeof body.id !== "number") return NextResponse.json({ error: "id is required" }, { status: 400 });

    const map: Record<string, RunMode> = {
      "regen-image": "scene-regen-image",
      "regen-video": "scene-regen-video",
      "generate-video": "scene-generate-video",
    };
    const mode = map[body.action];
    if (!mode) return NextResponse.json({ error: `unknown action '${body.action}'` }, { status: 400 });

    const info = runner.start(mode, { ids: [body.id], force: body.force });
    return NextResponse.json({ runId: info.id, mode: info.mode, ids: info.ids });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
