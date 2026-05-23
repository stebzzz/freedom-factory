import { NextResponse } from "next/server";
import { loadProjectState } from "@/lib/projects/state";
import { concatRunner } from "@/lib/projects/concat";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const state = loadProjectState(slug);
  if (!state) return NextResponse.json({ error: `projet '${slug}' inconnu` }, { status: 404 });
  return NextResponse.json({
    ...state,
    activeConcat: concatRunner.getActive(slug),
  });
}
