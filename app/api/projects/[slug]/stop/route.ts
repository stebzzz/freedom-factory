import { NextResponse } from "next/server";
import { multiRunner } from "@/lib/projects/runner";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ok = multiRunner.stop(slug);
  return NextResponse.json({ ok });
}
