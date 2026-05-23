import type { SourcingAsset } from "../types";
import { getConfig } from "@/lib/config";

const API = "https://pixabay.com/api";

interface PixabayPhoto {
  id: number;
  pageURL: string;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  tags: string;
}

interface PixabayVideoSizes {
  large?: { url: string; width: number; height: number };
  medium?: { url: string; width: number; height: number };
  small?: { url: string; width: number; height: number };
  tiny?: { url: string; width: number; height: number };
}

interface PixabayVideo {
  id: number;
  pageURL: string;
  duration: number;
  videos: PixabayVideoSizes;
  user: string;
  tags: string;
  picture_id?: string;
}

export async function searchPixabayImages(query: string, limit = 12): Promise<SourcingAsset[]> {
  const config = await getConfig();
  if (!config.pixabayKey) return [];
  const res = await fetch(`${API}/?key=${config.pixabayKey}&q=${encodeURIComponent(query)}&image_type=photo&per_page=${limit}&safesearch=true`);
  if (!res.ok) throw new Error(`pixabay images ${res.status}`);
  const data = (await res.json()) as { hits: PixabayPhoto[] };
  return (data.hits || []).map((p): SourcingAsset => ({
    id: `pixabay:photo:${p.id}`,
    provider: "pixabay",
    kind: "image",
    thumbnailUrl: p.previewURL,
    previewUrl: p.webformatURL,
    downloadUrl: p.largeImageURL,
    width: p.imageWidth,
    height: p.imageHeight,
    title: p.tags,
    author: p.user,
    sourceUrl: p.pageURL,
    license: "Pixabay Content License (free)",
    query,
  }));
}

export async function searchPixabayVideos(query: string, limit = 8): Promise<SourcingAsset[]> {
  const config = await getConfig();
  if (!config.pixabayKey) return [];
  const res = await fetch(`${API}/videos/?key=${config.pixabayKey}&q=${encodeURIComponent(query)}&per_page=${limit}&safesearch=true`);
  if (!res.ok) throw new Error(`pixabay videos ${res.status}`);
  const data = (await res.json()) as { hits: PixabayVideo[] };
  return (data.hits || []).map((v): SourcingAsset => {
    const best = v.videos.large || v.videos.medium || v.videos.small || v.videos.tiny;
    const thumb = v.picture_id
      ? `https://i.vimeocdn.com/video/${v.picture_id}_295x166.jpg`
      : best?.url ?? "";
    return {
      id: `pixabay:video:${v.id}`,
      provider: "pixabay",
      kind: "video",
      thumbnailUrl: thumb,
      previewUrl: best?.url ?? "",
      downloadUrl: best?.url ?? "",
      width: best?.width,
      height: best?.height,
      durationSec: v.duration,
      title: v.tags,
      author: v.user,
      sourceUrl: v.pageURL,
      license: "Pixabay Content License (free)",
      query,
    };
  });
}
