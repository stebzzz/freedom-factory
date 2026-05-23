import type { SourcingAsset } from "../types";

const API = "https://commons.wikimedia.org/w/api.php";

interface SearchHit {
  pageid: number;
  title: string;
}

interface ImageInfo {
  url: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  width: number;
  height: number;
  descriptionshorturl: string;
  user?: string;
  extmetadata?: Record<string, { value: string }>;
}

interface PageWithImageInfo {
  pageid: number;
  title: string;
  imageinfo?: ImageInfo[];
}

export async function searchWikimediaImages(query: string, limit = 10): Promise<SourcingAsset[]> {
  // Step 1: search pages in File namespace.
  const searchUrl = `${API}?action=query&format=json&origin=*&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=${limit}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`wikimedia search ${searchRes.status}`);
  const searchData = (await searchRes.json()) as { query?: { search?: SearchHit[] } };
  const hits = searchData.query?.search ?? [];
  if (!hits.length) return [];

  // Step 2: batch-fetch imageinfo for found titles.
  const titles = hits.map((h) => h.title).join("|");
  const infoUrl = `${API}?action=query&format=json&origin=*&prop=imageinfo&iiprop=url|extmetadata|user&iiurlwidth=600&titles=${encodeURIComponent(titles)}`;
  const infoRes = await fetch(infoUrl);
  if (!infoRes.ok) throw new Error(`wikimedia imageinfo ${infoRes.status}`);
  const infoData = (await infoRes.json()) as { query?: { pages?: Record<string, PageWithImageInfo> } };
  const pages = infoData.query?.pages ?? {};

  const assets: SourcingAsset[] = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    // Skip non-image filetypes (svg, ogv, etc.) — strip querystring before matching extension.
    const urlPath = info.url.split("?")[0];
    if (!/\.(jpe?g|png|webp|gif)$/i.test(urlPath)) continue;
    const meta = info.extmetadata ?? {};
    const author = stripHtml(meta.Artist?.value || info.user || "");
    const license = stripHtml(meta.LicenseShortName?.value || meta.License?.value || "Wikimedia Commons");
    assets.push({
      id: `wikimedia:${page.pageid}`,
      provider: "wikimedia",
      kind: "image",
      thumbnailUrl: info.thumburl ?? info.url,
      previewUrl: info.thumburl ?? info.url,
      downloadUrl: info.url,
      width: info.width,
      height: info.height,
      title: page.title.replace(/^File:/, ""),
      author,
      sourceUrl: info.descriptionshorturl,
      license,
      query,
    });
  }
  return assets;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s{2,}/g, " ").trim();
}
