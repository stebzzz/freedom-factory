import type { SourcingAsset } from "../types";
import { getConfig } from "@/lib/config";

const API = "https://api.pexels.com";

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt?: string;
  src: { tiny: string; small: string; medium: string; large: string; large2x: string; original: string };
}

interface PexelsVideoFile {
  link: string;
  quality: string;
  width: number;
  height: number;
  file_type: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user: { name: string; url: string };
  video_files: PexelsVideoFile[];
}

export async function searchPexelsImages(query: string, limit = 12): Promise<SourcingAsset[]> {
  const config = await getConfig();
  if (!config.pexelsKey) return [];
  const res = await fetch(`${API}/v1/search?query=${encodeURIComponent(query)}&per_page=${limit}`, {
    headers: { Authorization: config.pexelsKey },
  });
  if (!res.ok) throw new Error(`pexels images ${res.status}`);
  const data = (await res.json()) as { photos: PexelsPhoto[] };
  return (data.photos || []).map((p): SourcingAsset => ({
    id: `pexels:photo:${p.id}`,
    provider: "pexels",
    kind: "image",
    thumbnailUrl: p.src.medium,
    previewUrl: p.src.large,
    downloadUrl: p.src.original,
    width: p.width,
    height: p.height,
    title: p.alt,
    author: p.photographer,
    authorUrl: p.photographer_url,
    sourceUrl: p.url,
    license: "Pexels License (free)",
    query,
  }));
}

export async function searchPexelsVideos(query: string, limit = 8): Promise<SourcingAsset[]> {
  const config = await getConfig();
  if (!config.pexelsKey) return [];
  const res = await fetch(`${API}/videos/search?query=${encodeURIComponent(query)}&per_page=${limit}`, {
    headers: { Authorization: config.pexelsKey },
  });
  if (!res.ok) throw new Error(`pexels videos ${res.status}`);
  const data = (await res.json()) as { videos: PexelsVideo[] };
  return (data.videos || []).map((v): SourcingAsset => {
    const hd = v.video_files.find((f) => f.quality === "hd" && f.width >= 1280) ?? v.video_files[0];
    return {
      id: `pexels:video:${v.id}`,
      provider: "pexels",
      kind: "video",
      thumbnailUrl: v.image,
      previewUrl: hd?.link ?? v.image,
      downloadUrl: hd?.link ?? v.image,
      width: v.width,
      height: v.height,
      durationSec: v.duration,
      author: v.user.name,
      authorUrl: v.user.url,
      sourceUrl: v.url,
      license: "Pexels License (free)",
      query,
    };
  });
}
