import { callClaudeRetry } from "@/lib/api/claude-wrapper-client";
import { jsonrepair } from "jsonrepair";
import type { SourcingAsset } from "./types";

async function callAnthropic(prompt: string, maxTokens = 1024): Promise<string> {
  const response = await callClaudeRetry(
    "claude-haiku-4-5-20251001",
    maxTokens,
    [{ role: "user", content: prompt }],
    "Claude Sourcing",
  );
  return response.content[0]?.text ?? "";
}

function parseJsonLoose<T>(raw: string, fallback: T): T {
  // Strip markdown code fences and common preambles
  const cleaned = raw
    .replace(/```(?:json)?\n?/g, "")
    .replace(/```/g, "")
    .trim();
  // Try to locate the first { or [
  const start = Math.min(
    ...["{", "["].map((c) => {
      const i = cleaned.indexOf(c);
      return i === -1 ? Infinity : i;
    })
  );
  if (start === Infinity) return fallback;
  const candidate = cleaned.slice(start);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(candidate)) as T;
    } catch {
      return fallback;
    }
  }
}

/**
 * Claude generates 5-10 short, varied search queries for archive providers from a video title.
 */
export async function generateSourcingQueries(title: string, hint?: string): Promise<string[]> {
  const prompt = `Tu es un assistant de recherche d'archives photo/vidéo (Pexels, Wikimedia Commons, Pixabay, Unsplash) pour des vidéos YouTube faceless.

Titre de la vidéo : "${title}"
${hint ? `Contexte additionnel : ${hint}` : ""}

Génère 5 à 10 queries de recherche EN ANGLAIS, courts (2-4 mots max), variés, pour trouver des images et vidéos d'archive pertinentes.
Privilégie des queries concrets et visuels (lieux, objets, époques, actions) plutôt qu'abstraits.
Évite les noms propres très spécifiques sauf s'ils sont incontournables.

Réponds UNIQUEMENT en JSON, format strict :
{ "queries": ["query 1", "query 2", "query 3", ...] }`;

  const text = await callAnthropic(prompt, 512);
  const parsed = parseJsonLoose<{ queries?: string[] }>(text, { queries: [] });
  const queries = (parsed.queries ?? []).filter((q) => typeof q === "string" && q.trim().length > 0);
  return queries.slice(0, 10);
}

/**
 * Re-ranks the merged search results by relevance to the original title.
 * Returns the assets in ranked order, with rankScore (0-100) and rankReason populated.
 */
export async function rankSourcingResults(
  title: string,
  assets: SourcingAsset[],
  topN = 60,
): Promise<SourcingAsset[]> {
  if (assets.length === 0) return [];

  // Send a compact view to Claude — id + provider + kind + title + query.
  const compact = assets.map((a) => ({
    id: a.id,
    p: a.provider,
    k: a.kind,
    t: (a.title || "").slice(0, 80),
    q: a.query,
  }));

  const prompt = `Tu classes des résultats d'archives photo/vidéo par pertinence pour la vidéo intitulée :
"${title}"

Voici les ${compact.length} résultats (id, provider, kind, title, query). Donne un score de pertinence 0-100 (100 = parfait) à chacun, et garde les meilleurs.

${JSON.stringify(compact, null, 0)}

Réponds UNIQUEMENT en JSON :
{ "ranked": [ { "id": "...", "score": 95, "reason": "raison courte" }, ... ] }
Trie par score décroissant. Inclus tous les ${compact.length} résultats.`;

  let text: string;
  try {
    text = await callAnthropic(prompt, 4096);
  } catch (e) {
    console.warn(`[sourcing] rank failed: ${(e as Error).message}`);
    return assets.slice(0, topN);
  }

  const parsed = parseJsonLoose<{ ranked?: Array<{ id: string; score: number; reason?: string }> }>(text, { ranked: [] });
  const ranked = parsed.ranked ?? [];
  const scoreById = new Map<string, { score: number; reason?: string }>();
  for (const r of ranked) {
    if (r.id && typeof r.score === "number") {
      scoreById.set(r.id, { score: r.score, reason: r.reason });
    }
  }

  const enriched = assets.map((a) => {
    const s = scoreById.get(a.id);
    return s ? { ...a, rankScore: s.score, rankReason: s.reason } : a;
  });
  enriched.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
  return enriched.slice(0, topN);
}
