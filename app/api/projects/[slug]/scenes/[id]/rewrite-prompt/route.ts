import { NextRequest, NextResponse } from "next/server";
import { callClaudeRetry } from "@/lib/api/claude-wrapper-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface Body {
  vo: string;
  currentPrompt?: string;
}

const SYSTEM = `You are a prompt rewriter for a stickman-style YouTube explainer pipeline (think Sam-O-Nella / AfterSkool).
You receive ONE narration beat (1-6 words of voice-over) and must produce ONE English image prompt that visualises it.

Constraints:
- ONE sentence, 18-35 words, English only.
- Stay simple: flat 2D, thin black lines, mostly white background, no shadows, no gradients, no realistic anatomy.
- Use stickmen ONLY when the narration calls for a human action/reaction. Otherwise prefer object-only or symbolic visuals (timeline, gear, calendar, candle, target, magnifying glass, chart, sign, melting clock, cracked object, etc.).
- Show the HIDDEN MEANING, not the literal words. Abstract narration → metaphor. Transition narration → reveal/anomaly/crack. Number/date narration → giant labeled object.
- Allowed short labels (1-4 words max) when they sharpen the image. Forbidden: full sentences as labels, speech bubbles repeating the narration.
- NEVER start with "Here is" / "This image shows" / any preamble. Output ONLY the final sentence, nothing else.`;

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  void slug;
  const sceneId = parseInt(id, 10);
  if (Number.isNaN(sceneId)) return NextResponse.json({ error: "id invalide" }, { status: 400 });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const vo = (body.vo ?? "").trim();
  if (!vo) return NextResponse.json({ error: "voice-over vide" }, { status: 400 });

  const userPrompt = `Narration: "${vo}"
${body.currentPrompt ? `\nPrevious imagePrompt (for context — feel free to fully replace):\n${body.currentPrompt}\n` : ""}
Write the new image prompt (one sentence, 18-35 words, English):`;

  try {
    const response = await callClaudeRetry(
      "claude-sonnet-4-6",
      400,
      [
        { role: "user", content: `${SYSTEM}\n\n${userPrompt}` },
      ],
      "Rewrite Prompt",
    );
    const text = (response.content[0]?.text ?? "").trim();
    const clean = text
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^Here['']?s.*?:\s*/i, "")
      .replace(/^Image prompt:\s*/i, "")
      .trim();
    if (!clean) return NextResponse.json({ error: "Claude a renvoyé une réponse vide" }, { status: 500 });
    return NextResponse.json({ imagePrompt: clean });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
