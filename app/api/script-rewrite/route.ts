import { NextRequest, NextResponse } from "next/server";
import { callClaudeRetry } from "@/lib/api/claude-wrapper-client";

export const dynamic = "force-dynamic";

/**
 * POST /api/script-rewrite
 * Body: { segments: string[] }
 * Returns: { segments: { original: string, modified: string, wordsChanged: number }[] }
 *
 * Paraphrases ~10% of words in each segment using Claude (via VPS wrapper).
 * Strict synonym-only replacement to avoid hallucinations.
 */
export async function POST(req: NextRequest) {
  try {
    const { segments } = (await req.json()) as { segments: string[] };

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return NextResponse.json({ error: "segments[] requis" }, { status: 400 });
    }

    // Process all segments in parallel — the wrapper client caps concurrency at 3.
    const results = await Promise.all(segments.map((text) => paraphraseSegment(text)));

    return NextResponse.json({ segments: results });
  } catch (err) {
    console.error("[script-rewrite] Error:", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

async function paraphraseSegment(
  text: string,
): Promise<{ original: string; modified: string; wordsChanged: number }> {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const targetChanges = Math.max(1, Math.round(wordCount * 0.1));

  const response = await callClaudeRetry(
    "claude-sonnet-4-6",
    4096,
    [{
      role: "user",
      content: `Tu es un outil de paraphrase. Tu dois modifier EXACTEMENT ~${targetChanges} mots (10% du texte) en les remplacant par des synonymes.

REGLES STRICTES :
- Remplace ~${targetChanges} mots par des synonymes naturels
- NE CHANGE PAS le sens, la structure, ni la ponctuation
- NE RETIRE et N'AJOUTE aucune phrase
- Garde la meme longueur totale
- Reponds UNIQUEMENT avec le texte modifie, rien d'autre

TEXTE A MODIFIER :
${text}`,
    }],
    "Paraphrase",
  );

  const modified = response.content[0]?.text?.trim() || text;

  // Count actual word changes
  const origWords = text.split(/\s+/).filter(Boolean);
  const modWords = modified.split(/\s+/).filter(Boolean);
  let wordsChanged = 0;
  const minLen = Math.min(origWords.length, modWords.length);
  for (let i = 0; i < minLen; i++) {
    if (origWords[i].toLowerCase() !== modWords[i].toLowerCase()) wordsChanged++;
  }
  wordsChanged += Math.abs(origWords.length - modWords.length);

  return { original: text, modified, wordsChanged };
}
