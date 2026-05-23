import { NextResponse } from "next/server";
import { rewritePrompt } from "@/lib/api/prompt-rewrite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  let body: { prompt?: string; instruction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "Champ 'prompt' requis" }, { status: 400 });
  }
  try {
    const next = await rewritePrompt(body.prompt, body.instruction);
    return NextResponse.json({ prompt: next });
  } catch (err) {
    console.error("[improve-prompt] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
