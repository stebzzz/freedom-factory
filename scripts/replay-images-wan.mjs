#!/usr/bin/env node
// Replay the image step of a job via Alibaba DashScope WAN 2.7 (Singapore region).
// Usage:
//   set -a && source .env.local && set +a
//   node scripts/replay-images-wan.mjs <jobId> [scene1 scene2 ...]
//
// Reads:
//   - public/generated/<jobId>/script.json      (imagePrompt per scene)
//   - public/generated/<jobId>/refs-mapping.json (refs per scene from describe-kit)
// Writes:
//   - public/generated/<jobId>/images/scene_<idx>.png
//
// WAN is SYNCHRONOUS: each call returns the image URL directly, no polling.
// Refs are inlined as base64 data URIs (0-9 per scene, WAN supports up to 9).

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const REF_PREFIX = "Use the image reference. Match the style of the reference image as closely as possible. ";
const REGION = (process.env.DASHSCOPE_REGION || "intl").toLowerCase();
const API_BASE = REGION === "cn"
  ? "https://dashscope.aliyuncs.com/api/v1"
  : "https://dashscope-intl.aliyuncs.com/api/v1";
const ENDPOINT = `${API_BASE}/services/aigc/multimodal-generation/generation`;
const MODEL = process.env.WAN_MODEL || "wan2.7-image";
const SIZE = "1280*720";
const PUBLIC_GENERATED = path.join(process.cwd(), "public", "generated");

const SUBMIT_CONCURRENCY = 3;
const SUBMIT_SPACING_MS = 4000;

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

async function refToDataUri(refPath) {
  const buf = await readFile(refPath);
  return `data:${mimeFor(refPath)};base64,${buf.toString("base64")}`;
}

async function downloadTo(url, target) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download ${r.status}: ${target}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(target, buf);
  return buf.length;
}

async function generateOne(key, prompt, refPaths) {
  const content = [{ text: prompt }];
  for (const p of refPaths.slice(0, 9)) {
    content.push({ image: await refToDataUri(p) });
  }
  const body = {
    model: MODEL,
    input: { messages: [{ role: "user", content }] },
    parameters: { size: SIZE, n: 1, watermark: false },
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.code) {
    throw new Error(`WAN ${data.code ?? res.status}: ${data.message ?? "no message"}`);
  }
  const url = data.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!url) throw new Error("WAN: no image URL");
  return url;
}

async function main() {
  const [jobId, ...filter] = process.argv.slice(2);
  if (!jobId) {
    console.error("Usage: node scripts/replay-images-wan.mjs <jobId> [sceneIdx ...]");
    process.exit(1);
  }
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) { console.error("DASHSCOPE_API_KEY missing"); process.exit(1); }

  const jobDir = path.join(PUBLIC_GENERATED, jobId);
  const imagesDir = path.join(jobDir, "images");
  await mkdir(imagesDir, { recursive: true });

  const script = JSON.parse(await readFile(path.join(jobDir, "script.json"), "utf-8"));
  let refsMapping = null;
  try { refsMapping = JSON.parse(await readFile(path.join(jobDir, "refs-mapping.json"), "utf-8")); }
  catch { console.warn("no refs-mapping.json — running without refs"); }

  const refsByScene = new Map();
  if (refsMapping?.scenes) {
    for (const row of refsMapping.scenes) {
      const refs = (row.refs ?? []).map((r) => {
        const rel = r.url.startsWith("/") ? r.url.slice(1) : r.url;
        return path.join(process.cwd(), "public", rel);
      });
      refsByScene.set(row.sceneIndex, refs);
    }
  }

  const wanted = filter.length > 0 ? new Set(filter.map((s) => parseInt(s, 10))) : null;
  const scenes = (script.scenes ?? []).filter((s) => {
    if (wanted) return wanted.has(s.index);
    return refsByScene.has(s.index);
  });

  // Skip scenes already on disk.
  const todo = [];
  for (const s of scenes) {
    const target = path.join(imagesDir, `scene_${String(s.index).padStart(3, "0")}.png`);
    try { await stat(target); console.log(`  scene ${s.index} → SKIP (on disk)`); }
    catch { todo.push({ scene: s, target }); }
  }
  if (todo.length === 0) { console.log("Nothing to do."); return; }

  console.log(`WAN ${MODEL} (${REGION}) — ${todo.length} scènes, concurrency=${SUBMIT_CONCURRENCY}`);
  const stats = { ok: 0, fail: 0 };

  for (let i = 0; i < todo.length; i += SUBMIT_CONCURRENCY) {
    const batch = todo.slice(i, i + SUBMIT_CONCURRENCY);
    await Promise.all(batch.map(async ({ scene, target }) => {
      const refs = refsByScene.get(scene.index) ?? [];
      const prompt = `${REF_PREFIX}${scene.imagePrompt}`;
      const t0 = Date.now();
      try {
        const url = await generateOne(key, prompt, refs);
        const bytes = await downloadTo(url, target);
        console.log(`  scene ${scene.index} ✓ ${path.basename(target)} (${(bytes/1024).toFixed(0)} kB, ${((Date.now()-t0)/1000).toFixed(1)}s)`);
        stats.ok += 1;
      } catch (err) {
        console.warn(`  scene ${scene.index} FAILED: ${err.message.slice(0, 160)}`);
        stats.fail += 1;
      }
    }));
    if (i + SUBMIT_CONCURRENCY < todo.length) {
      await new Promise((r) => setTimeout(r, SUBMIT_SPACING_MS));
    }
  }
  console.log(`\nDone — ${stats.ok} ok, ${stats.fail} fail`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
