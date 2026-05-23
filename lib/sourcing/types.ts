export type AssetKind = "image" | "video";
export type Provider = "pexels" | "wikimedia" | "pixabay" | "unsplash";

export interface SourcingAsset {
  id: string;            // unique stable id : `${provider}:${nativeId}`
  provider: Provider;
  kind: AssetKind;
  thumbnailUrl: string;  // small preview (~300-600px)
  previewUrl: string;    // medium quality (~1080p) for in-grid play
  downloadUrl: string;   // best available
  width?: number;
  height?: number;
  durationSec?: number;  // videos only
  title?: string;
  author?: string;
  authorUrl?: string;
  sourceUrl: string;     // page on the provider
  license?: string;      // human-readable hint (CC0, CC-BY-SA, royalty-free, etc.)
  query: string;         // query that surfaced this asset
  matchedKeywords?: string[];
  rankScore?: number;    // populated by Claude-rank step
  rankReason?: string;
}

export interface SearchResult {
  query: string;
  assets: SourcingAsset[];
  errors: Array<{ provider: Provider; message: string }>;
}

export interface SourcingPack {
  slug: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  queries: string[];           // keywords used
  attachedProject?: string;     // if linked to a /projects slug
  assets: Array<SourcingAsset & { localPath?: string; downloadedAt?: number }>;
}

export interface DownloadTarget {
  type: "pack" | "project";
  slug: string;  // pack slug or project slug
}
