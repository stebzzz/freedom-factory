// Analyse vision (QC) des images d'un job pipeline : renvoie la liste des images
// "ratées" (severity minor|bad) avec leurs défauts. Utilisé par le bouton manuel
// "QC vision" de la page Jobs ChannelFlow.
import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/pipeline/runner";
import { findImageIssues } from "@/lib/api/claude-vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

function urlFor(imagePath: string): string {
  const i = imagePath.indexOf("/generated/");
  return i === -1 ? imagePath : imagePath.slice(i);
}

export async function POST(req: NextRequest) {
  let body: { jobId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const jobId = body.jobId;
  if (!jobId) return NextResponse.json({ error: "jobId requis" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job introuvable en mémoire (serveur redémarré ?)" }, { status: 404 });

  const images = job.result.images ?? [];
  if (images.length === 0) return NextResponse.json({ flagged: [], total: 0 });

  const flagged: Array<{ sceneIndex: number; url: string; severity: string; issues: string[]; prompt: string }> = [];
  const CONC = 3;
  for (let i = 0; i < images.length; i += CONC) {
    const batch = images.slice(i, i + CONC);
    const res = await Promise.all(
      batch.map(async (img) => {
        try {
          return { img, r: await findImageIssues(img.imagePath) };
        } catch {
          return { img, r: { severity: "ok" as const, issues: [] as string[] } };
        }
      }),
    );
    for (const { img, r } of res) {
      if (r.severity !== "ok") {
        flagged.push({
          sceneIndex: img.sceneIndex,
          url: urlFor(img.imagePath),
          severity: r.severity,
          issues: r.issues,
          prompt: img.prompt,
        });
      }
    }
  }

  flagged.sort((a, b) => a.sceneIndex - b.sceneIndex);
  return NextResponse.json({ flagged, total: images.length });
}
