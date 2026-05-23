import type { SourcingAsset } from "../types";
import { getConfig } from "@/lib/config";

const API = "https://api.unsplash.com";

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  alt_description?: string;
  description?: string;
  urls: { thumb: string; small: string; regular: string; full: string; raw: string };
  user: { name: string; links: { html: string } };
  links: { html: string; download_location?: string };
}

export async function searchUnsplashImages(query: string, limit = 12): Promise<SourcingAsset[]> {
  const config = await getConfig();
  if (!config.unsplashKey) return [];
  const res = await fetch(`${API}/search/photos?query=${encodeURIComponent(query)}&per_page=${limit}`, {
    headers: { Authorization: `Client-ID ${config.unsplashKey}` },
  });
  if (!res.ok) throw new Error(`unsplash ${res.status}`);
  const data = (await res.json()) as { results: UnsplashPhoto[] };
  return (data.results || []).map((p): SourcingAsset => ({
    id: `unsplash:${p.id}`,
    provider: "unsplash",
    kind: "image",
    thumbnailUrl: p.urls.small,
    previewUrl: p.urls.regular,
    downloadUrl: p.urls.full,
    width: p.width,
    height: p.height,
    title: p.alt_description || p.description || undefined,
    author: p.user.name,
    authorUrl: p.user.links.html,
    sourceUrl: p.links.html,
    license: "Unsplash License (free)",
    query,
  }));
}
