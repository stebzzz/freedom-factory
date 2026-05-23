// ===================================================================
// Archives — Wikimedia Commons images + Pexels videos
// Recherche, telechargement, attribution overlay
// ===================================================================

import { writeFile, mkdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import path from "path";
import { execSync } from "child_process";
import { ArchiveItem, ArchiveResult, ScriptScene } from "@/lib/pipeline/types";

// ── Keyword cleanup ──────────────────────────────────────────────────
const REMOVE_KEYWORDS =
  /\b(cinematic|photorealistic|8k|4k|ultra hd|hyperrealistic|photo-?real|dramatic|lighting|rich colors|16:9|soft|warm|golden|dreamy|painterly|serene|peaceful|gentle|mood|quality|photography|beautiful|stunning|professional|watercolor|illustration|hand-painted|storybook|atmospheric|breathtaking|intimate|moody|realistic|textures|detailed|sharp|close-?up|wide shot|aerial shot|medium shot|camera|angle|sequence|composition|split-?screen|montage-?style|transition|dissolving|filtering|streaming|illuminating)\b/gi;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "over", "then", "than", "this", "that", "these",
  "those", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "shall", "can", "its", "their", "his", "her", "our", "your", "style", "shot",
  "showing", "featuring", "another", "figure", "figures", "like", "very", "scene",
]);

/** Extrait des mots-cles de recherche depuis un imagePrompt IA */
export function extractSearchQuery(imagePrompt: string): string {
  const cleaned = imagePrompt
    .replace(REMOVE_KEYWORDS, "")
    .replace(/,+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z]/g, ""))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 5);
  return words.join(" ") || "historical";
}

// ── Wikimedia Commons API ────────────────────────────────────────────

interface WikimediaHit {
  thumbUrl: string;
  pageUrl: string;
  author: string;
  license: string;
  description: string;
  width: number;
  mime: string;
}

export async function searchWikimedia(
  query: string,
  limit: number = 3,
): Promise<WikimediaHit[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: `${query} filetype:bitmap`,
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|extmetadata|size|mime",
    iiurlwidth: "1920",
    format: "json",
    origin: "*",
  });

  const url = `https://commons.wikimedia.org/w/api.php?${params}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "YouTubeFreedomFactory/1.0 (archive search)" },
  });

  if (!res.ok) return [];
  const data = await res.json();
  if (!data.query?.pages) return [];

  const results: WikimediaHit[] = [];
  for (const page of Object.values(data.query.pages) as Array<Record<string, unknown>>) {
    const info = (page.imageinfo as Array<Record<string, unknown>>)?.[0];
    if (!info) continue;

    const meta = info.extmetadata as Record<string, { value?: string }> | undefined;
    const mime = (info.mime as string) || "";

    // Only accept actual images (skip SVG, PDF, etc.)
    if (!mime.startsWith("image/") || mime.includes("svg")) continue;

    const thumbUrl = (info.thumburl as string) || (info.url as string) || "";
    if (!thumbUrl) continue;

    results.push({
      thumbUrl,
      pageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(String(page.title || "").replace("File:", ""))}`,
      author: stripHtml(meta?.Artist?.value || "Unknown"),
      license: meta?.LicenseShortName?.value || "Public Domain",
      description: stripHtml(meta?.ImageDescription?.value || ""),
      width: (info.thumbwidth as number) || (info.width as number) || 0,
      mime,
    });
  }

  // Prefer larger images
  return results.sort((a, b) => b.width - a.width);
}

// ── Pexels Video API ─────────────────────────────────────────────────

interface PexelsVideoHit {
  videoUrl: string;
  pageUrl: string;
  photographer: string;
  duration: number; // seconds
  width: number;
}

export async function searchPexelsVideos(
  query: string,
  pexelsKey: string,
  maxDuration: number = 5,
  limit: number = 3,
): Promise<PexelsVideoHit[]> {
  if (!pexelsKey) return [];

  const params = new URLSearchParams({
    query,
    per_page: String(limit),
    size: "medium",
  });

  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: pexelsKey },
  });

  if (!res.ok) return [];
  const data = await res.json();
  if (!data.videos?.length) return [];

  const results: PexelsVideoHit[] = [];
  for (const video of data.videos as Array<Record<string, unknown>>) {
    const dur = video.duration as number;
    if (dur > maxDuration) continue;

    // Pick best video file (prefer HD ~1920 width)
    const files = (video.video_files as Array<Record<string, unknown>>) || [];
    const hdFile = files
      .filter((f) => (f.width as number) >= 1280)
      .sort((a, b) => (b.width as number) - (a.width as number))[0]
      || files[0];

    if (!hdFile?.link) continue;

    results.push({
      videoUrl: hdFile.link as string,
      pageUrl: video.url as string,
      photographer: (video.user as Record<string, string>)?.name || "Unknown",
      duration: dur,
      width: (hdFile.width as number) || 1280,
    });
  }

  return results;
}

// ── Download ─────────────────────────────────────────────────────────

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "YouTubeFreedomFactory/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 5000) throw new Error(`File too small (${buffer.length} bytes)`);
  await writeFile(outputPath, buffer);
}

// ── Attribution Overlay ──────────────────────────────────────────────

const MAGICK_BIN = process.env.MAGICK_BIN || "magick";

/**
 * Brule une barre d'attribution semi-transparente en bas de l'image.
 * Pour les videos, on retourne le fichier tel quel (attribution via ASS dans le montage).
 */
export async function burnAttribution(
  inputPath: string,
  type: "image" | "video",
  author: string,
  license: string,
): Promise<string> {
  // Videos: pas de burn, l'attribution sera en ASS pendant le montage
  if (type === "video") return inputPath;

  const outputPath = inputPath.replace(/(\.\w+)$/, `_attr$1`);
  const text = `Source: ${author} / ${license}`.slice(0, 100); // max 100 chars

  try {
    // ImageMagick: barre noire semi-transparente + texte blanc en bas
    execSync(
      `${MAGICK_BIN} "${inputPath}" \\( +clone -fill "rgba(0,0,0,0.55)" -draw "rectangle 0,%[fx:h-55] %[fx:w],0%[fx:h]" \\) -composite -fill white -pointsize 22 -gravity SouthWest -annotate +15+15 "${text.replace(/"/g, '\\"')}" "${outputPath}"`,
      { stdio: "pipe", timeout: 30000 },
    );
    return outputPath;
  } catch {
    console.warn(`[Archives] ImageMagick attribution failed for ${inputPath}, using original`);
    return inputPath;
  }
}

// ── Credits File ─────────────────────────────────────────────────────

export async function generateCredits(
  items: ArchiveItem[],
  outputPath: string,
): Promise<void> {
  const lines = [
    "=== ARCHIVE CREDITS ===",
    `Generated: ${new Date().toISOString().split("T")[0]}`,
    "",
  ];

  for (const item of items) {
    lines.push(
      `Scene ${item.sceneIndex + 1} - [${item.type}] "${item.query}"`,
      `  Source: ${item.source === "wikimedia" ? "Wikimedia Commons" : "Pexels"}`,
      `  Author: ${item.attribution.author}`,
      `  License: ${item.attribution.license}`,
      `  URL: ${item.attribution.pageUrl}`,
      "",
    );
  }

  lines.push("=== END CREDITS ===");
  await writeFile(outputPath, lines.join("\n"));
}

// ── Main Orchestrator ────────────────────────────────────────────────

export type ArchiveDensity = "all" | "alternate" | "sparse" | "none";

/**
 * Sélection irrégulière de scènes — pas un pattern fixe.
 * Utilise un PRNG seedé sur le nombre de scènes pour être reproductible
 * mais avec un espacement variable (2-5 scènes entre chaque archive).
 */
function getEligibleScenes(
  scenes: ScriptScene[],
  density: ArchiveDensity,
): ScriptScene[] {
  if (density === "none") return [];
  if (density === "all") return [...scenes];

  // Plages d'espacement selon la densité
  const gaps: Record<string, [number, number]> = {
    alternate: [1, 3],  // entre 1 et 3 scènes d'écart → ~40% des scènes
    sparse:    [2, 5],  // entre 2 et 5 scènes d'écart → ~25% des scènes
  };
  const [minGap, maxGap] = gaps[density] || gaps.sparse;

  // PRNG simple (Mulberry32) — seedé sur le nombre de scènes
  let seed = scenes.length * 2654435761;
  function rand(): number {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const eligible: ScriptScene[] = [];
  let nextIdx = Math.floor(rand() * (maxGap - minGap)) + minGap; // premier décalé aussi

  while (nextIdx < scenes.length) {
    eligible.push(scenes[nextIdx]);
    const gap = minGap + Math.floor(rand() * (maxGap - minGap + 1));
    nextIdx += gap;
  }

  return eligible;
}

export async function fetchArchivesForScenes(
  scenes: ScriptScene[],
  outputDir: string,
  pexelsKey: string,
  density: ArchiveDensity,
  onProgress?: (done: number, total: number) => void,
): Promise<ArchiveResult> {
  await mkdir(outputDir, { recursive: true });

  const eligible = getEligibleScenes(scenes, density);
  const items: ArchiveItem[] = [];
  let done = 0;

  for (const scene of eligible) {
    const query = extractSearchQuery(scene.imagePrompt);
    console.log(`[Archives] Scene ${scene.index} — query: "${query}"`);

    let found = false;

    // 1. Essayer Pexels video d'abord (plus engageant)
    if (pexelsKey && !found) {
      try {
        const videos = await searchPexelsVideos(query, pexelsKey, 5, 3);
        if (videos.length > 0) {
          const best = videos[0];
          const rawPath = path.join(outputDir, `archive_${scene.index}_raw.mp4`);
          await downloadFile(best.videoUrl, rawPath);

          const attrPath = await burnAttribution(rawPath, "video", best.photographer, "Pexels License");

          items.push({
            sceneIndex: scene.index,
            type: "video",
            filePath: attrPath,
            originalUrl: best.videoUrl,
            source: "pexels",
            attribution: {
              author: best.photographer,
              license: "Pexels License",
              pageUrl: best.pageUrl,
            },
            durationSeconds: best.duration,
            query,
          });

          found = true;
          console.log(`[Archives] Scene ${scene.index} — Pexels video: ${best.photographer} (${best.duration}s)`);
        }
      } catch (err) {
        console.warn(`[Archives] Pexels error for scene ${scene.index}:`, (err as Error).message);
      }
    }

    // 2. Fallback: Wikimedia image
    if (!found) {
      try {
        const images = await searchWikimedia(query, 3);
        if (images.length > 0) {
          const best = images[0];
          const ext = best.mime.includes("jpeg") || best.mime.includes("jpg") ? ".jpg" : ".png";
          const rawPath = path.join(outputDir, `archive_${scene.index}_raw${ext}`);
          await downloadFile(best.thumbUrl, rawPath);

          // Valider le fichier telecharge
          if (existsSync(rawPath) && statSync(rawPath).size > 10000) {
            const attrPath = await burnAttribution(rawPath, "image", best.author, best.license);

            items.push({
              sceneIndex: scene.index,
              type: "image",
              filePath: attrPath,
              originalUrl: best.thumbUrl,
              source: "wikimedia",
              attribution: {
                author: best.author,
                license: best.license,
                pageUrl: best.pageUrl,
              },
              query,
            });

            found = true;
            console.log(`[Archives] Scene ${scene.index} — Wikimedia: ${best.author} (${best.license})`);
          }
        }
      } catch (err) {
        console.warn(`[Archives] Wikimedia error for scene ${scene.index}:`, (err as Error).message);
      }
    }

    if (!found) {
      console.log(`[Archives] Scene ${scene.index} — aucun resultat pour "${query}"`);
    }

    done++;
    onProgress?.(done, eligible.length);

    // Rate limiting: 500ms entre les requetes
    await new Promise((r) => setTimeout(r, 500));
  }

  const creditsPath = path.join(outputDir, "..", "credits.txt");
  await generateCredits(items, creditsPath);

  console.log(`[Archives] ${items.length}/${eligible.length} archives trouvees`);
  return { items, creditsPath };
}

// ── Helpers ──────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .trim();
}
