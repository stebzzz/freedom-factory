import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { classifyImage, describeImage, describeStyle } from "@/lib/api/claude-vision";
import { consolidateStyleBrief, rankRefsForScenes } from "@/lib/api/claude";
import { fetchVideoKeyframes, fetchTranscript, detectLanguageFromText } from "@/lib/api/youtube";
import type { KitImage, KitMeta, KitMode, KitSummary, KitTag } from "./types";

const ROOT = process.cwd();
const KITS_DIR = path.join(ROOT, "public/style-refs");
const MIN_FILE_BYTES = 12_000; // <12 kB → almost always a logo / decorative glyph
const MAX_FILE_BYTES = 19_500_000; // Veo create-image limit is 20 MB, keep margin

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `kit-${Date.now()}`;
}

function urlFor(slug: string, tag: KitTag, filename: string): string {
  return `/style-refs/${slug}/${tag}/${filename}`;
}

async function runPdfimages(pdfPath: string, outPrefix: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // -all keeps original format (JPEG stays JPEG, PNG stays PNG) — preserves quality.
    const child = spawn("pdfimages", ["-all", pdfPath, outPrefix]);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(new Error(`pdfimages spawn: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pdfimages exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function sha256(buf: Buffer): Promise<string> {
  return createHash("sha256").update(buf).digest("hex");
}

interface ExtractedImage {
  tmpPath: string;
  buffer: Buffer;
  ext: string;
  sizeBytes: number;
}

async function extractAndFilter(pdfPath: string, workDir: string): Promise<ExtractedImage[]> {
  const outPrefix = path.join(workDir, "img");
  await runPdfimages(pdfPath, outPrefix);

  const entries = await readdir(workDir);
  const seenHashes = new Set<string>();
  const out: ExtractedImage[] = [];

  for (const name of entries.sort()) {
    if (!/^img-\d+\.(png|jpe?g|jp2|webp)$/i.test(name)) continue;
    const fp = path.join(workDir, name);
    const st = await stat(fp);
    if (st.size < MIN_FILE_BYTES) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    const buf = await readFile(fp);
    const h = await sha256(buf);
    if (seenHashes.has(h)) continue;
    seenHashes.add(h);
    const ext = path.extname(name).slice(1).toLowerCase();
    out.push({ tmpPath: fp, buffer: buf, ext, sizeBytes: st.size });
  }

  return out;
}

export async function importPdf(
  pdfBuffer: Buffer,
  rawSlug: string,
  sourceName?: string,
  mode: KitMode = "classify",
): Promise<KitMeta> {
  const slug = slugify(rawSlug);
  const kitDir = path.join(KITS_DIR, slug);
  const characterDir = path.join(kitDir, "character");
  const styleDir = path.join(kitDir, "style");

  // Reset target dirs so a re-import gives a clean slate.
  if (existsSync(kitDir)) await rm(kitDir, { recursive: true, force: true });
  await mkdir(characterDir, { recursive: true });
  await mkdir(styleDir, { recursive: true });

  // Work in a tmpdir so pdfimages can scatter files freely.
  const workDir = path.join(os.tmpdir(), `style-kit-${slug}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const pdfPath = path.join(workDir, "source.pdf");
  await writeFile(pdfPath, pdfBuffer);

  try {
    const extracted = await extractAndFilter(pdfPath, workDir);
    if (extracted.length === 0) {
      throw new Error(
        "Aucune image exploitable détectée dans le PDF (pdfimages n'a rien renvoyé au-dessus de 12 kB). " +
          "Si le PDF est un export vectoriel aplati, exporte-le en PDF avec images intégrées ou fais des screenshots manuels."
      );
    }

    const character: KitImage[] = [];
    const style: KitImage[] = [];

    // Sequential per-image Haiku call: keeps logs ordered and rate-friendly. With ~5-30
    // images per kit and ~600ms-2s per Haiku call this stays well under maxDuration.
    for (let i = 0; i < extracted.length; i++) {
      const item = extracted[i];
      const finalName = `img-${String(i + 1).padStart(3, "0")}.${item.ext}`;

      let tag: KitTag = "style";
      let label = "";
      let imagePrompt = "";

      if (mode === "describe") {
        try {
          imagePrompt = await describeImage(item.tmpPath);
        } catch (err) {
          console.warn(`[style-kit] describeImage failed for ${finalName}:`, (err as Error).message);
        }
      } else {
        try {
          const result = await classifyImage(item.tmpPath);
          tag = result.hasCharacter ? "character" : "style";
          label = result.label;
        } catch (err) {
          console.warn(`[style-kit] classify failed for ${finalName}, defaulting to style:`, (err as Error).message);
        }
      }

      const destDir = tag === "character" ? characterDir : styleDir;
      const destPath = path.join(destDir, finalName);
      await rename(item.tmpPath, destPath);

      const entry: KitImage = {
        filename: finalName,
        url: urlFor(slug, tag, finalName),
        tag,
        label,
        sizeBytes: item.sizeBytes,
        ...(imagePrompt ? { imagePrompt } : {}),
      };
      (tag === "character" ? character : style).push(entry);
    }

    const meta: KitMeta = {
      slug,
      sourcePdf: sourceName,
      createdAt: new Date().toISOString(),
      mode,
      character,
      style,
    };
    await writeFile(path.join(kitDir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Build a style kit from a YouTube video.
 *  1. yt-dlp downloads a 360p copy.
 *  2. ffmpeg extracts a frame every `cadenceSeconds` seconds.
 *  3. Each frame: Haiku Vision classify (character/style) + Haiku Vision describe (style snippet).
 *  4. Claude Sonnet consolidates snippets into a single styleBrief.
 *  5. Frames saved to public/style-refs/<slug>/{character,style}/ — same layout as importPdf.
 */
export async function importFromYouTube(
  url: string,
  rawSlug: string,
  cadenceSeconds: number = 3,
  mode: KitMode = "classify",
): Promise<KitMeta & { truncated?: boolean; expectedCount?: number }> {
  const slug = slugify(rawSlug);
  const kitDir = path.join(KITS_DIR, slug);
  const characterDir = path.join(kitDir, "character");
  const styleDir = path.join(kitDir, "style");

  if (existsSync(kitDir)) await rm(kitDir, { recursive: true, force: true });
  await mkdir(characterDir, { recursive: true });
  await mkdir(styleDir, { recursive: true });

  const tmpFramesDir = path.join(os.tmpdir(), `kit-frames-${slug}-${Date.now()}`);

  try {
    const extraction = await fetchVideoKeyframes(url, cadenceSeconds, tmpFramesDir);
    const framePaths = extraction.framePaths;
    if (framePaths.length === 0) {
      throw new Error("Aucune frame extraite — la vidéo est peut-être trop courte ou inaccessible");
    }

    const character: KitImage[] = [];
    const style: KitImage[] = [];
    const styleBriefs: string[] = [];

    // Process frames in parallel batches. Each frame = 2 Haiku calls (classify + describe).
    // Anthropic default tier ≈ 50 rpm, batch of 10 means 20 rpm bursts — safe headroom.
    // 200 frames at concurrency 10 ≈ 20 batches × ~1.5s = 30s wall-clock instead of 5 min.
    const CONC = 10;
    const totalFrames = framePaths.length;

    for (let i = 0; i < totalFrames; i += CONC) {
      const batch = framePaths.slice(i, i + CONC);
      await Promise.all(
        batch.map(async (framePath, idx) => {
          const globalIdx = i + idx;
          const finalName = `frame-${String(globalIdx + 1).padStart(3, "0")}.png`;

          let tag: KitTag = "style";
          let label = "";
          let frameBrief = "";
          let imagePrompt = "";

          if (mode === "describe") {
            // Describe mode: single Haiku call per frame, no classification, no consolidated brief.
            const describeRes = await Promise.allSettled([describeImage(framePath)]);
            if (describeRes[0].status === "fulfilled") {
              imagePrompt = describeRes[0].value;
            } else {
              console.warn(`[style-kit] describeImage failed for ${finalName}:`, (describeRes[0].reason as Error)?.message);
            }
          } else {
            const [classifyResult, describeResult] = await Promise.allSettled([
              classifyImage(framePath),
              describeStyle(framePath),
            ]);

            if (classifyResult.status === "fulfilled") {
              tag = classifyResult.value.hasCharacter ? "character" : "style";
              label = classifyResult.value.label;
            } else {
              console.warn(`[style-kit] classify failed for ${finalName}:`, (classifyResult.reason as Error)?.message);
            }
            if (describeResult.status === "fulfilled") {
              frameBrief = describeResult.value;
              if (frameBrief) styleBriefs.push(frameBrief);
            } else {
              console.warn(`[style-kit] describeStyle failed for ${finalName}:`, (describeResult.reason as Error)?.message);
            }
          }

          const destDir = tag === "character" ? characterDir : styleDir;
          const destPath = path.join(destDir, finalName);
          await rename(framePath, destPath);
          const st = await stat(destPath);

          const entry: KitImage = {
            filename: finalName,
            url: urlFor(slug, tag, finalName),
            tag,
            label,
            sizeBytes: st.size,
            ...(imagePrompt ? { imagePrompt } : {}),
          };
          (tag === "character" ? character : style).push(entry);
        }),
      );
      console.log(`[style-kit] processed ${Math.min(i + CONC, totalFrames)}/${totalFrames} frames`);
    }

    // Order didn't preserve through parallel processing — sort by filename for a clean kit.
    character.sort((a, b) => a.filename.localeCompare(b.filename));
    style.sort((a, b) => a.filename.localeCompare(b.filename));

    let styleBrief: string | undefined;
    if (mode === "classify") {
      if (styleBriefs.length >= 2) {
        try {
          styleBrief = await consolidateStyleBrief(styleBriefs);
        } catch (err) {
          console.warn(`[style-kit] consolidateStyleBrief failed (non-blocking):`, (err as Error).message);
        }
      } else if (styleBriefs.length === 1) {
        // Only one frame produced a brief — use it raw rather than consolidating from a single source.
        styleBrief = styleBriefs[0];
      }
    }

    // Detect the source video's narration language (best-effort, non-blocking).
    // Cached here so the pipeline can route a French voix → English narration when the
    // kit was built from an English video, and vice-versa.
    let narrationLanguage: "en" | "fr" | undefined;
    try {
      const transcript = await fetchTranscript(url);
      narrationLanguage = detectLanguageFromText(transcript);
      if (narrationLanguage) console.log(`[style-kit] '${slug}' narrationLanguage=${narrationLanguage}`);
    } catch (err) {
      console.warn(`[style-kit] language detect failed (non-blocking):`, (err as Error).message);
    }

    const meta: KitMeta = {
      slug,
      sourceUrl: url,
      createdAt: new Date().toISOString(),
      mode,
      character,
      style,
      styleBrief,
      ...(narrationLanguage ? { narrationLanguage } : {}),
    };
    await writeFile(path.join(kitDir, "meta.json"), JSON.stringify(meta, null, 2));
    return { ...meta, truncated: extraction.truncated, expectedCount: extraction.expectedCount };
  } finally {
    try {
      await rm(tmpFramesDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

async function readKitMeta(slug: string): Promise<KitMeta | null> {
  const metaPath = path.join(KITS_DIR, slug, "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(await readFile(metaPath, "utf-8")) as KitMeta;
  } catch {
    return null;
  }
}

export async function listKits(): Promise<KitSummary[]> {
  if (!existsSync(KITS_DIR)) return [];
  const slugs = await readdir(KITS_DIR);
  const out: KitSummary[] = [];
  for (const slug of slugs) {
    const meta = await readKitMeta(slug);
    if (!meta) continue;
    const source: KitSummary["source"] = meta.sourceUrl ? "youtube" : meta.sourcePdf ? "pdf" : "unknown";
    out.push({
      slug: meta.slug,
      createdAt: meta.createdAt,
      mode: meta.mode ?? "classify",
      characterCount: meta.character.length,
      styleCount: meta.style.length,
      previewUrl: meta.character[0]?.url ?? meta.style[0]?.url,
      hasStyleBrief: !!meta.styleBrief?.trim(),
      source,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getKit(slug: string): Promise<KitMeta | null> {
  return readKitMeta(slug);
}

export async function retagImage(slug: string, filename: string, nextTag: KitTag): Promise<KitMeta> {
  const meta = await readKitMeta(slug);
  if (!meta) throw new Error(`kit '${slug}' not found`);
  const kitDir = path.join(KITS_DIR, slug);

  const inCharacter = meta.character.findIndex((i) => i.filename === filename);
  const inStyle = meta.style.findIndex((i) => i.filename === filename);
  const currentTag: KitTag | null = inCharacter >= 0 ? "character" : inStyle >= 0 ? "style" : null;
  if (!currentTag) throw new Error(`image '${filename}' not in kit '${slug}'`);
  if (currentTag === nextTag) return meta;

  const fromPath = path.join(kitDir, currentTag, filename);
  const toPath = path.join(kitDir, nextTag, filename);
  await rename(fromPath, toPath);

  const moved =
    currentTag === "character"
      ? meta.character.splice(inCharacter, 1)[0]
      : meta.style.splice(inStyle, 1)[0];
  moved.tag = nextTag;
  moved.url = urlFor(slug, nextTag, filename);
  (nextTag === "character" ? meta.character : meta.style).push(moved);

  await writeFile(path.join(kitDir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function deleteImage(slug: string, filename: string): Promise<KitMeta> {
  const meta = await readKitMeta(slug);
  if (!meta) throw new Error(`kit '${slug}' not found`);
  const kitDir = path.join(KITS_DIR, slug);

  const idxChar = meta.character.findIndex((i) => i.filename === filename);
  const idxStyle = meta.style.findIndex((i) => i.filename === filename);
  if (idxChar < 0 && idxStyle < 0) throw new Error(`image '${filename}' not in kit '${slug}'`);

  const tag: KitTag = idxChar >= 0 ? "character" : "style";
  await rm(path.join(kitDir, tag, filename), { force: true });
  if (tag === "character") meta.character.splice(idxChar, 1);
  else meta.style.splice(idxStyle, 1);

  await writeFile(path.join(kitDir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function deleteKit(slug: string): Promise<void> {
  const kitDir = path.join(KITS_DIR, slug);
  if (!existsSync(kitDir)) return;
  await rm(kitDir, { recursive: true, force: true });
}

const CHARACTER_KEYWORDS = [
  "stickman",
  "stickmen",
  "stick figure",
  "stick-figure",
  "human",
  "humans",
  "person",
  "people",
  "figure",
  "hand",
  "hands",
  "face",
  "body",
  "silhouette",
];

export function sceneNeedsCharacter(imagePrompt: string): boolean {
  const lower = imagePrompt.toLowerCase();
  return CHARACTER_KEYWORDS.some((kw) => lower.includes(kw));
}

export async function resolveRefsForScene(
  slug: string,
  imagePrompt: string,
): Promise<string[]> {
  const meta = await readKitMeta(slug);
  if (!meta) return [];
  const charPaths = meta.character.map((i) => path.join(KITS_DIR, slug, "character", i.filename));
  const stylePaths = meta.style.map((i) => path.join(KITS_DIR, slug, "style", i.filename));

  // 5-ref budget. When the scene wants a character, allocate 1 char + 4 style;
  // otherwise pure style refs. Falling back gracefully if a bucket is empty.
  const wantsCharacter = sceneNeedsCharacter(imagePrompt) && charPaths.length > 0;

  if (wantsCharacter) {
    const pickedChar = charPaths.slice(0, 1);
    const pickedStyle = stylePaths.slice(0, 4);
    return [...pickedChar, ...pickedStyle].slice(0, 5);
  }
  return stylePaths.slice(0, 5);
}

/** Return all reference paths inside a kit, ignoring the internal character/style split.
 *  Used by the dual-kit mode where each kit is assumed homogeneous. */
export async function listAllKitRefs(slug: string): Promise<string[]> {
  const meta = await readKitMeta(slug);
  if (!meta) return [];
  const charPaths = meta.character.map((i) => path.join(KITS_DIR, slug, "character", i.filename));
  const stylePaths = meta.style.map((i) => path.join(KITS_DIR, slug, "style", i.filename));
  return [...charPaths, ...stylePaths];
}

/**
 * Dual-kit resolver. When a scene mentions a human, refs and brief come ENTIRELY from humanSlug.
 * When it doesn't, they come ENTIRELY from objectSlug. Each kit is assumed homogeneous (no
 * cross-contamination between human and non-human refs). Empty slug → no refs for that branch.
 */
export async function resolveSplitRefsForScene(
  humanSlug: string | undefined,
  objectSlug: string | undefined,
  imagePrompt: string,
): Promise<string[]> {
  const wantsHuman = sceneNeedsCharacter(imagePrompt);
  const slug = (wantsHuman ? humanSlug : objectSlug) || "";
  if (!slug) return [];
  const all = await listAllKitRefs(slug);
  return all.slice(0, 5);
}

/**
 * Describe-mode resolver. Reads the kit's per-image `imagePrompt`s, asks Claude to map each
 * scene's image prompt to the best-matching ${topN} kit images in a single batch call, and
 * returns the mapping as absolute paths ready to feed `generateImages.resolveRefsForScene`.
 *
 * Falls back to first-N images when:
 *  - the kit isn't in describe mode
 *  - no kit image has an imagePrompt
 *  - the Sonnet call fails (logged, non-blocking)
 */
export async function buildDescribeKitMapping(
  slug: string,
  scenes: Array<{ index: number; imagePrompt: string }>,
  topN = 5,
): Promise<Map<number, string[]> | null> {
  const meta = await readKitMeta(slug);
  if (!meta) return null;
  if (meta.mode !== "describe") return null;

  const allImages: Array<{ filename: string; tag: KitTag; imagePrompt?: string }> = [
    ...meta.character.map((i) => ({ filename: i.filename, tag: i.tag, imagePrompt: i.imagePrompt })),
    ...meta.style.map((i) => ({ filename: i.filename, tag: i.tag, imagePrompt: i.imagePrompt })),
  ];
  const withPrompts = allImages.filter((i) => (i.imagePrompt ?? "").trim().length > 0);
  if (withPrompts.length === 0) return null;

  const pathFor = (filename: string): string => {
    const found = allImages.find((i) => i.filename === filename);
    if (!found) return "";
    return path.join(KITS_DIR, slug, found.tag, filename);
  };

  let ranking: Array<{ index: number; filenames: string[] }>;
  try {
    ranking = await rankRefsForScenes(
      scenes.map((s) => ({ index: s.index, imagePrompt: s.imagePrompt })),
      withPrompts.map((i) => ({ filename: i.filename, imagePrompt: i.imagePrompt! })),
      topN,
    );
  } catch (err) {
    console.warn(`[style-kit] rankRefsForScenes failed, fallback first-${topN}:`, (err as Error).message);
    const fallbackPaths = withPrompts.slice(0, topN).map((i) => pathFor(i.filename)).filter(Boolean);
    const map = new Map<number, string[]>();
    for (const s of scenes) map.set(s.index, fallbackPaths);
    return map;
  }

  const map = new Map<number, string[]>();
  const fallbackPaths = withPrompts.slice(0, topN).map((i) => pathFor(i.filename)).filter(Boolean);
  for (const s of scenes) {
    const row = ranking.find((r) => r.index === s.index);
    const paths = (row?.filenames ?? []).map(pathFor).filter(Boolean);
    map.set(s.index, paths.length > 0 ? paths : fallbackPaths);
  }
  return map;
}

/** Pick the styleBrief for a given scene under the dual-kit setup. */
export async function resolveSplitBriefForScene(
  humanSlug: string | undefined,
  objectSlug: string | undefined,
  imagePrompt: string,
): Promise<string> {
  const wantsHuman = sceneNeedsCharacter(imagePrompt);
  const slug = (wantsHuman ? humanSlug : objectSlug) || "";
  if (!slug) return "";
  const meta = await readKitMeta(slug);
  return meta?.styleBrief?.trim() ?? "";
}
