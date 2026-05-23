import { NextRequest, NextResponse } from "next/server";
import {
  loadAllPresets,
  saveCustomPreset,
  deleteCustomPreset,
  isBuiltinPreset,
} from "@/lib/presets/custom-presets-store";
import type { ChannelPreset } from "@/lib/presets/channel-presets";

export const dynamic = "force-dynamic";

/**
 * GET /api/presets — returns all presets (built-in + custom)
 * Each preset includes a `_builtin` flag so the UI knows which are editable.
 */
export async function GET() {
  const all = await loadAllPresets();
  const withFlags = all.map((p) => ({
    ...p,
    _builtin: isBuiltinPreset(p.id),
  }));
  return NextResponse.json(withFlags);
}

/**
 * POST /api/presets — create or update a custom preset
 * Body: full ChannelPreset JSON
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChannelPreset;

    if (!body.id || !body.label) {
      return NextResponse.json(
        { error: "id and label are required" },
        { status: 400 }
      );
    }

    if (isBuiltinPreset(body.id)) {
      return NextResponse.json(
        { error: `Cannot overwrite built-in preset "${body.id}"` },
        { status: 400 }
      );
    }

    await saveCustomPreset(body);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/presets?id=xxx — delete a custom preset
 */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id query param required" }, { status: 400 });
  }

  if (isBuiltinPreset(id)) {
    return NextResponse.json(
      { error: `Cannot delete built-in preset "${id}"` },
      { status: 400 }
    );
  }

  try {
    await deleteCustomPreset(id);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
