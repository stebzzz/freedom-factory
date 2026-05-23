import { NextResponse } from "next/server";
import { listProjects } from "@/lib/projects/registry";
import { multiRunner } from "@/lib/projects/runner";

export const dynamic = "force-dynamic";

export async function GET() {
  const projects = listProjects();
  const enriched = projects.map((p) => ({
    ...p,
    activeRun: multiRunner.getActive(p.slug),
  }));
  return NextResponse.json({ projects: enriched });
}
