import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProject } from "@/lib/projects/registry";
import { syncMontageToChannelFlowByDir } from "@/lib/integrations/channelflow-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return NextResponse.json({ error: "projet inconnu" }, { status: 404 });

  const jobDir = project.outDir;
  const montagePath = ["master.mp4", "output.mp4"]
    .map((f) => path.join(jobDir, f))
    .find((p) => existsSync(p));

  if (!montagePath) {
    return NextResponse.json({ error: "Aucune vidéo finale trouvée (master.mp4 / output.mp4)" }, { status: 400 });
  }

  const markerPath = path.join(jobDir, "channelflow.json");
  if (!existsSync(markerPath)) {
    return NextResponse.json({ error: "channelflow.json absent — ce projet ne vient pas de ChannelFlow" }, { status: 400 });
  }

  try {
    await syncMontageToChannelFlowByDir(jobDir, montagePath);
    return NextResponse.json({ ok: true, montagePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
