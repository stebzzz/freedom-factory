#!/usr/bin/env node
// Replay the image step of a job by hitting GenAIPro create-image directly.
// Usage:
//   set -a && source .env.local && set +a
//   node scripts/replay-images-genaipro.mjs <jobId> [scene1 scene2 ...]
//
// Strategy (v2 — batched, gentle on GenAIPro):
//  1) POST all pending scenes with 15s spacing between batches of 3.
//  2) Single shared poll loop: every 30s, fetch /histories once, mark any of our task IDs
//     that flipped to completed/failed, download images, repeat until all done or timeout.
//
// This pattern matches what the production runner does (lib/api/genaipro.ts).
// Avoids burst-polling /histories per-scene which triggers GenAIPro's own rate-limit.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const REF_PREFIX = "Use the image reference. Match the style of the reference image as closely as possible. ";
const API_BASE = "https://genaipro.io/api";
const ASPECT_IMG = "IMAGE_ASPECT_RATIO_LANDSCAPE";
const PUBLIC_GENERATED = path.join(process.cwd(), "public", "generated");

const SUBMIT_CONCURRENCY = 3;
const SUBMIT_SPACING_MS = 15_000;
const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 25 * 60 * 1000;

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

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function postCreateImage(token, prompt, refPath) {
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("aspect_ratio", ASPECT_IMG);
  fd.append("number_of_images", "1");
  if (refPath) {
    const buf = await readFile(refPath);
    fd.append("reference_images", new Blob([buf], { type: mimeFor(refPath) }), path.basename(refPath));
  }
  const res = await fetch(`${API_BASE}/v2/veo/create-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`create-image ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error(`create-image: no id (${JSON.stringify(data).slice(0, 200)})`);
  return data.id;
}

async function main() {
  const [jobId, ...filterStr] = process.argv.slice(2);
  if (!jobId) {
    console.error("Usage: node scripts/replay-images-genaipro.mjs <jobId> [sceneIdx ...]");
    process.exit(1);
  }
  const token = process.env.GENAIPRO_API_KEY;
  if (!token) { console.error("GENAIPRO_API_KEY missing"); process.exit(1); }

  const jobDir = path.join(PUBLIC_GENERATED, jobId);
  const imagesDir = path.join(jobDir, "images");
  await mkdir(imagesDir, { recursive: true });

  const script = JSON.parse(await readFile(path.join(jobDir, "script.json"), "utf-8"));
  const refsMappingPath = path.join(jobDir, "refs-mapping.json");
  let refsMapping = null;
  try { refsMapping = JSON.parse(await readFile(refsMappingPath, "utf-8")); }
  catch { console.warn("no refs-mapping.json — running without refs"); }

  const refsByScene = new Map();
  if (refsMapping?.scenes) {
    for (const row of refsMapping.scenes) {
      const refFiles = (row.refs ?? []).map((r) => {
        const rel = r.url.startsWith("/") ? r.url.slice(1) : r.url;
        return path.join(process.cwd(), "public", rel);
      });
      refsByScene.set(row.sceneIndex, refFiles);
    }
  }

  const wantedIndexes = filterStr.length > 0 ? new Set(filterStr.map((s) => parseInt(s, 10))) : null;
  const allScenes = (script.scenes ?? []).filter((s) => {
    if (wantedIndexes) return wantedIndexes.has(s.index);
    return refsByScene.has(s.index);
  });

  // Skip scenes already on disk.
  const scenes = [];
  for (const s of allScenes) {
    const target = path.join(imagesDir, `scene_${String(s.index).padStart(3, "0")}.png`);
    try {
      await stat(target);
      console.log(`  scene ${s.index} → SKIP (already on disk)`);
    } catch {
      scenes.push({ scene: s, target });
    }
  }
  if (scenes.length === 0) { console.log("Nothing to do."); return; }
  console.log(`Replay ${scenes.length} scènes (kit=${refsMapping?.kit ?? "none"})`);

  // 1) POST all scenes in spaced batches.
  const taskByScene = new Map(); // taskId -> { scene, target }
  for (let i = 0; i < scenes.length; i += SUBMIT_CONCURRENCY) {
    const batch = scenes.slice(i, i + SUBMIT_CONCURRENCY);
    await Promise.all(batch.map(async ({ scene, target }) => {
      const refPath = (refsByScene.get(scene.index) ?? [])[0] ?? null;
      const fullPrompt = `${REF_PREFIX}${scene.imagePrompt}`;
      try {
        const taskId = await postCreateImage(token, fullPrompt, refPath);
        taskByScene.set(taskId, { scene, target });
        console.log(`  POST scene ${scene.index} → ${taskId.slice(0, 8)}… (ref=${refPath ? path.basename(refPath) : "none"})`);
      } catch (err) {
        console.warn(`  POST scene ${scene.index} FAILED: ${err.message.slice(0, 120)}`);
      }
    }));
    if (i + SUBMIT_CONCURRENCY < scenes.length) {
      console.log(`  ... waiting ${SUBMIT_SPACING_MS / 1000}s before next batch`);
      await new Promise((r) => setTimeout(r, SUBMIT_SPACING_MS));
    }
  }

  if (taskByScene.size === 0) { console.error("No tasks submitted."); return; }
  console.log(`\n${taskByScene.size} tasks submitted, polling every ${POLL_INTERVAL_MS / 1000}s...`);

  // 2) Single shared poll loop.
  const pending = new Set(taskByScene.keys());
  const start = Date.now();
  let stats = { downloaded: 0, failed: 0 };

  while (pending.size > 0 && Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let page = 1;
    while (pending.size > 0) {
      let body;
      try {
        const r = await fetch(`${API_BASE}/v2/veo/histories?page=${page}&page_size=100`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 429) {
          console.warn(`  /histories 429 — backing off 60s`);
          await new Promise((s) => setTimeout(s, 60_000));
          continue;
        }
        if (!r.ok) throw new Error(`histories ${r.status}`);
        body = await r.json();
      } catch (err) {
        console.warn(`  poll error: ${err.message.slice(0, 120)}`);
        break;
      }
      const items = body.data ?? [];
      for (const item of items) {
        if (!pending.has(item.id)) continue;
        if (item.status !== "completed" && item.status !== "failed") continue;
        const entry = taskByScene.get(item.id);
        const { scene, target } = entry;
        pending.delete(item.id);
        if (item.status !== "completed" || !item.file_urls?.[0]) {
          console.warn(`  scene ${scene.index} FAILED: ${item.error ?? "no result"}`);
          stats.failed += 1;
        } else {
          try {
            const bytes = await downloadTo(item.file_urls[0], target);
            console.log(`  scene ${scene.index} ✓ ${path.basename(target)} (${(bytes/1024).toFixed(0)} kB)`);
            stats.downloaded += 1;
          } catch (err) {
            console.warn(`  scene ${scene.index} download FAILED: ${err.message}`);
            stats.failed += 1;
          }
        }
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages || items.length === 0) break;
      page++;
    }
    if (pending.size > 0) {
      console.log(`  ... ${pending.size} pending / ${taskByScene.size} total`);
    }
  }

  if (pending.size > 0) {
    console.warn(`\nTIMEOUT after ${Math.round((Date.now() - start) / 1000)}s — ${pending.size} tasks still pending`);
  }
  console.log(`\nDone — ${stats.downloaded} ok, ${stats.failed} fail, ${pending.size} pending`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
