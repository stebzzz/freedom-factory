import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";
import type { SourcingAsset, SourcingPack, DownloadTarget } from "./types";

const ROOT = process.cwd();
const PACKS_DIR = path.join(ROOT, "public/sourcing");
const PROJECTS_DIR = path.join(ROOT, "public/generated");

function packsRoot(): string {
  if (!existsSync(PACKS_DIR)) mkdirSync(PACKS_DIR, { recursive: true });
  return PACKS_DIR;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || `pack-${Date.now()}`;
}

function uniqueSlug(base: string): string {
  packsRoot();
  let slug = base;
  let i = 2;
  while (existsSync(path.join(PACKS_DIR, slug))) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

export function listPacks(): SourcingPack[] {
  packsRoot();
  const entries = readdirSync(PACKS_DIR).filter((f) => {
    const full = path.join(PACKS_DIR, f);
    return statSync(full).isDirectory() && existsSync(path.join(full, "pack.json"));
  });
  return entries.map((slug) => loadPack(slug)).filter((p): p is SourcingPack => p !== null);
}

export function loadPack(slug: string): SourcingPack | null {
  const file = path.join(PACKS_DIR, slug, "pack.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SourcingPack;
  } catch {
    return null;
  }
}

export function createPack(title: string, queries: string[], attachedProject?: string): SourcingPack {
  const base = slugify(title);
  const slug = uniqueSlug(base);
  const dir = path.join(PACKS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, "images"), { recursive: true });
  mkdirSync(path.join(dir, "videos"), { recursive: true });

  const pack: SourcingPack = {
    slug,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    queries,
    attachedProject,
    assets: [],
  };
  writeFileSync(path.join(dir, "pack.json"), JSON.stringify(pack, null, 2));
  return pack;
}

function savePack(pack: SourcingPack) {
  pack.updatedAt = Date.now();
  const dir = path.join(PACKS_DIR, pack.slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "pack.json"), JSON.stringify(pack, null, 2));
}

function extFromUrl(url: string, fallback: string): string {
  const cleaned = url.split("?")[0];
  const m = cleaned.match(/\.([a-zA-Z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : fallback;
}

function safeFilename(asset: SourcingAsset): string {
  const ext = extFromUrl(asset.downloadUrl, asset.kind === "image" ? "jpg" : "mp4");
  const slug = (asset.title || asset.author || asset.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  const idHash = asset.id.split(":").pop() ?? "x";
  return `${slug || asset.kind}_${idHash}.${ext}`;
}

async function downloadOne(url: string, outputPath: string): Promise<number> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buf);
  return buf.length;
}

interface DownloadResult {
  ok: number;
  failed: Array<{ id: string; error: string }>;
  packSlug: string;
  outDir: string;
}

export async function downloadAssets(
  target: DownloadTarget,
  assets: SourcingAsset[],
  meta: { title?: string; queries?: string[] } = {},
): Promise<DownloadResult> {
  // Resolve output directory based on target.
  let outDir: string;
  let pack: SourcingPack | null;
  if (target.type === "pack") {
    pack = loadPack(target.slug);
    if (!pack) {
      pack = createPack(meta.title || target.slug, meta.queries || [], undefined);
    }
    outDir = path.join(PACKS_DIR, pack.slug);
  } else {
    // project
    const projectDir = path.join(PROJECTS_DIR, target.slug);
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });
    outDir = path.join(projectDir, "archives");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(path.join(outDir, "images"), { recursive: true });
    mkdirSync(path.join(outDir, "videos"), { recursive: true });
    pack = null;
  }

  const failed: DownloadResult["failed"] = [];
  let ok = 0;

  for (const asset of assets) {
    try {
      const subdir = asset.kind === "image" ? "images" : "videos";
      const filename = safeFilename(asset);
      const fpath = path.join(outDir, subdir, filename);
      await downloadOne(asset.downloadUrl, fpath);
      ok++;
      if (pack) {
        const existing = pack.assets.find((a) => a.id === asset.id);
        if (existing) {
          existing.localPath = fpath;
          existing.downloadedAt = Date.now();
        } else {
          pack.assets.push({ ...asset, localPath: fpath, downloadedAt: Date.now() });
        }
      }
    } catch (e) {
      failed.push({ id: asset.id, error: (e as Error).message });
    }
  }

  if (pack) savePack(pack);
  return { ok, failed, packSlug: pack?.slug ?? "", outDir };
}
