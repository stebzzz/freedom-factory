#!/usr/bin/env node
// Recovers images from completed Veo histories whose prompts match scenes in the given jobs.
// Usage:
//   node scripts/recover-veo-images.mjs <jobId> [<jobId>...]
// Reads each job's script.json, fetches all recent Veo histories, matches by prompt, and
// downloads matched completed images to public/generated/<jobId>/images/scene_<idx>.png.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const REF_PREFIX = "Use the image reference. Match the style of the reference image as closely as possible. ";
const API_BASE = "https://genaipro.io/api";
const PUBLIC_GENERATED = path.join(process.cwd(), "public", "generated");
const PAGE_SIZE = 100;
const MAX_PAGES = 30; // 3000 most recent histories — plenty for recent runs

function rewriteCdn(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}

async function downloadTo(url, target) {
  const r = await fetch(rewriteCdn(url), { redirect: "follow" });
  if (!r.ok) throw new Error(`download ${r.status}: ${target}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(target, buf);
  return buf.length;
}

function normPrompt(p) {
  return (p || "").trim().replace(/\s+/g, " ");
}

async function main() {
  const jobIds = process.argv.slice(2);
  if (jobIds.length === 0) {
    console.error("Usage: node scripts/recover-veo-images.mjs <jobId> [<jobId>...]");
    process.exit(1);
  }
  const token = process.env.GENAIPRO_API_KEY;
  if (!token) {
    console.error("GENAIPRO_API_KEY missing (export it or run via `npm run …` with .env.local loaded).");
    process.exit(1);
  }

  // 1. Build the prompt → {jobId, sceneIndex} map from all jobs.
  const promptIndex = new Map();
  for (const jobId of jobIds) {
    const scriptPath = path.join(PUBLIC_GENERATED, jobId, "script.json");
    try {
      await stat(scriptPath);
    } catch {
      console.warn(`[${jobId}] script.json absent, skip`);
      continue;
    }
    const script = JSON.parse(await readFile(scriptPath, "utf-8"));
    const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
    for (const s of scenes) {
      const full = normPrompt(REF_PREFIX + s.imagePrompt);
      if (!promptIndex.has(full)) {
        promptIndex.set(full, { jobId, sceneIndex: s.index });
      }
    }
    console.log(`[${jobId}] indexed ${scenes.length} scenes`);
  }
  console.log(`Total indexed prompts: ${promptIndex.size}`);

  // 2. Paginate Veo histories and match.
  const stats = { completed: 0, processing: 0, failed: 0, downloaded: 0, skipped: 0, unmatched: 0 };
  const downloadedPerJob = Object.fromEntries(jobIds.map((j) => [j, 0]));
  for (const jobId of jobIds) {
    await mkdir(path.join(PUBLIC_GENERATED, jobId, "images"), { recursive: true });
  }

  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${API_BASE}/v2/veo/histories?page=${page}&page_size=${PAGE_SIZE}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      console.warn(`page ${page}: HTTP ${r.status}, abort pagination`);
      break;
    }
    const body = await r.json();
    const items = body.data ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      if (item.status === "processing" || item.status === "pending") {
        const p = normPrompt(item.prompt);
        if (promptIndex.has(p)) stats.processing += 1;
        continue;
      }
      if (item.status === "failed") {
        const p = normPrompt(item.prompt);
        if (promptIndex.has(p)) stats.failed += 1;
        continue;
      }
      if (item.status !== "completed" || !Array.isArray(item.file_urls) || item.file_urls.length === 0) {
        continue;
      }
      const p = normPrompt(item.prompt);
      const match = promptIndex.get(p);
      if (!match) {
        stats.unmatched += 1;
        continue;
      }
      stats.completed += 1;
      const fname = `scene_${String(match.sceneIndex).padStart(3, "0")}.png`;
      const target = path.join(PUBLIC_GENERATED, match.jobId, "images", fname);
      try {
        await stat(target);
        stats.skipped += 1;
        continue; // already on disk
      } catch { /* not present */ }
      try {
        const bytes = await downloadTo(item.file_urls[0], target);
        stats.downloaded += 1;
        downloadedPerJob[match.jobId] = (downloadedPerJob[match.jobId] ?? 0) + 1;
        console.log(`[${match.jobId}] scene ${match.sceneIndex} → ${fname} (${(bytes / 1024).toFixed(0)} kB)`);
      } catch (err) {
        console.warn(`[${match.jobId}] scene ${match.sceneIndex} download FAILED:`, err.message);
      }
    }
    const totalPages = body.total_pages ?? 1;
    if (page >= totalPages) break;
  }

  console.log("\n=== Recovery summary ===");
  console.log(`Matched completed     : ${stats.completed}`);
  console.log(`  → downloaded        : ${stats.downloaded}`);
  console.log(`  → already on disk   : ${stats.skipped}`);
  console.log(`Matched processing    : ${stats.processing} (re-run script later to fetch)`);
  console.log(`Matched failed        : ${stats.failed}`);
  console.log(`Unmatched completed   : ${stats.unmatched} (other jobs / older runs)`);
  for (const [jobId, n] of Object.entries(downloadedPerJob)) {
    console.log(`  [${jobId}] +${n} new images`);
  }
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
