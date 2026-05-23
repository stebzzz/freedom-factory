import type { SourcingAsset, Provider, SearchResult } from "./types";
import { searchPexelsImages, searchPexelsVideos } from "./providers/pexels";
import { searchWikimediaImages } from "./providers/wikimedia";
import { searchPixabayImages, searchPixabayVideos } from "./providers/pixabay";
import { searchUnsplashImages } from "./providers/unsplash";
import { rankSourcingResults } from "./claude";

export interface AggregateOptions {
  imagesPerQuery?: number;
  videosPerQuery?: number;
  rankWithClaude?: boolean;
  topN?: number;
  title?: string; // for Claude rank
}

export async function searchAllProviders(query: string, opts: AggregateOptions = {}): Promise<SearchResult> {
  const imagesPerQuery = opts.imagesPerQuery ?? 8;
  const videosPerQuery = opts.videosPerQuery ?? 6;

  const calls: Array<{ provider: Provider; promise: Promise<SourcingAsset[]> }> = [
    { provider: "pexels",    promise: searchPexelsImages(query, imagesPerQuery) },
    { provider: "pexels",    promise: searchPexelsVideos(query, videosPerQuery) },
    { provider: "wikimedia", promise: searchWikimediaImages(query, imagesPerQuery) },
    { provider: "pixabay",   promise: searchPixabayImages(query, imagesPerQuery) },
    { provider: "pixabay",   promise: searchPixabayVideos(query, videosPerQuery) },
    { provider: "unsplash",  promise: searchUnsplashImages(query, imagesPerQuery) },
  ];

  const results = await Promise.allSettled(calls.map((c) => c.promise));
  const assets: SourcingAsset[] = [];
  const errors: SearchResult["errors"] = [];

  results.forEach((r, i) => {
    const provider = calls[i].provider;
    if (r.status === "fulfilled") {
      assets.push(...r.value);
    } else {
      errors.push({ provider, message: (r.reason as Error)?.message ?? String(r.reason) });
    }
  });

  // Dedup by downloadUrl (some providers may return identical CC0 sources).
  const seen = new Set<string>();
  const deduped = assets.filter((a) => {
    if (!a.downloadUrl) return false;
    if (seen.has(a.downloadUrl)) return false;
    seen.add(a.downloadUrl);
    return true;
  });

  return { query, assets: deduped, errors };
}

/**
 * Run multiple queries in parallel against all providers, dedup, and optionally Claude-rank.
 */
export async function multiQuerySearch(
  queries: string[],
  opts: AggregateOptions = {}
): Promise<{ assets: SourcingAsset[]; errors: SearchResult["errors"] }> {
  const results = await Promise.all(queries.map((q) => searchAllProviders(q, opts)));
  const assetMap = new Map<string, SourcingAsset>();
  const errors: SearchResult["errors"] = [];
  for (const r of results) {
    for (const a of r.assets) {
      // Keep first occurrence — earlier queries score higher in result order.
      if (!assetMap.has(a.id)) assetMap.set(a.id, a);
    }
    errors.push(...r.errors);
  }
  let assets = [...assetMap.values()];

  if (opts.rankWithClaude && opts.title && assets.length > 0) {
    try {
      assets = await rankSourcingResults(opts.title, assets, opts.topN ?? 60);
    } catch (e) {
      errors.push({ provider: "pexels", message: `rank failed: ${(e as Error).message}` });
    }
  }

  return { assets, errors };
}
