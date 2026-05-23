#!/usr/bin/env node
// WAN gen for missing scenes (or a specific subset via --only=0,30,60).
// Usage: node wan-gen.mjs <jobName> [--only=idx1,idx2,...]

import fs from "fs/promises";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

const ROOT = "/Users/stephanezayat/Documents/youtube-freedom-factory";
const WAN_KEY = process.env.DASHSCOPE_API_KEY;
const WAN_MODEL = "wan2.7-image";
const ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

if (!WAN_KEY) { console.error("Set DASHSCOPE_API_KEY"); process.exit(1); }
const args = process.argv.slice(2);
const jobName = args[0];
if (!jobName) { console.error("usage: <jobName> [--only=idx1,idx2,...]"); process.exit(1); }
const onlyArg = args.find(a => a.startsWith("--only="));
const onlyIndices = onlyArg ? new Set(onlyArg.replace("--only=", "").split(",").map(s => parseInt(s, 10))) : null;

const jobDir = `${ROOT}/public/generated/${jobName}`;
if (!existsSync(jobDir)) { console.error("jobDir not found:", jobDir); process.exit(1); }

const script = JSON.parse(await fs.readFile(`${jobDir}/script.json`, "utf-8"));
const mapping = JSON.parse(await fs.readFile(`${jobDir}/refs-mapping.json`, "utf-8"));
const refsByIdx = new Map(mapping.scenes.map(s => [s.sceneIndex, s.refs]));

const imagesDir = `${jobDir}/images`;
await fs.mkdir(imagesDir, { recursive: true });
const present = new Set((await fs.readdir(imagesDir)).filter(f => f.endsWith(".png")).map(f => parseInt(f.match(/(\d+)/)[1], 10)));
let targets = script.scenes.filter(s => !present.has(s.index));
if (onlyIndices) targets = targets.filter(s => onlyIndices.has(s.index));
console.log(`[wan] ${jobName}: ${present.size} present, ${targets.length} to generate${onlyIndices ? ` (filter --only)` : ""}`);
if (targets.length === 0) { console.log("[wan] nothing to do"); process.exit(0); }

async function refToDataUri(p) {
  const buf = await fs.readFile(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function generateOne(prompt, refPaths) {
  const refs = refPaths.slice(0, 9);
  let promptText = prompt;
  if (refs.length >= 2) {
    promptText = `STYLE REFERENCE (IMAGE 1): a generic stickman in this exact style — same line weight, head shape, proportions, simple eye dots, flat ink-line aesthetic. Use ONLY as STYLE TEMPLATE: replicate line quality and proportions, but the POSE, EXPRESSION, ACTION must be NEW matching the scene description. Do NOT copy IMAGE 1's stance.

SCENE REFERENCE (IMAGE 2): composition/object/environment inspiration. Layout hint only — do NOT copy its character style.

Scene to draw (NEW pose & action, IMAGE 1 line style only): ${prompt}`;
  } else if (refs.length === 1) {
    promptText = `STYLE REFERENCE: a generic stickman in this exact style. Use ONLY as a style template (line quality + proportions). The pose/expression/action must be NEW matching the scene below.

Scene to draw: ${prompt}`;
  }
  const content = [{ text: promptText }];
  for (const p of refs) content.push({ image: await refToDataUri(p) });
  const body = {
    model: WAN_MODEL,
    input: { messages: [{ role: "user", content }] },
    parameters: { size: "1280*720", n: 1, watermark: false },
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${WAN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.code) throw new Error(`WAN ${data.code ?? res.status}: ${data.message ?? "no msg"}`);
  const url = data.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image;
  if (!url) throw new Error("no image url");
  return url;
}

async function rewriteSafe(prompt) {
  const r = spawnSync("claude", ["-p"], {
    input: `Rewrite this image prompt to bypass an image-gen moderation filter (no violence/blood/explicit/proper names). Keep visual idea, simple stickman style. Output only the rewritten English prompt.

${prompt}`, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024,
  });
  return r.status === 0 ? (r.stdout || "").trim() : prompt;
}

async function downloadTo(url, outPath) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download ${r.status}`);
  await fs.writeFile(outPath, Buffer.from(await r.arrayBuffer()));
}

async function generateRetry(prompt, refPaths, sceneIndex) {
  let lastErr = null; let cur = prompt; let safeRewrote = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await generateOne(cur, refPaths); }
    catch (err) {
      lastErr = err;
      const msg = err.message;
      const moderation = /DataInspectionFailed|inappropriate|content filter|safety/i.test(msg);
      const transient = /Throttling|RateLimit|TooManyRequests|429|5\d\d|fetch failed|ECONN|ETIMEDOUT/i.test(msg);
      if (moderation && !safeRewrote) {
        console.warn(`[wan] scene ${sceneIndex} moderation, safe-rewriting`);
        cur = await rewriteSafe(prompt); safeRewrote = true; continue;
      }
      if (!transient || attempt === 4) throw err;
      await new Promise(r => setTimeout(r, attempt * 5000));
    }
  }
  throw lastErr;
}

const CONCURRENCY = 3; const BATCH_SLEEP_MS = 15000;
let ok = 0, fail = 0;
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = targets.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(async (scene) => {
    const refs = (refsByIdx.get(scene.index) || []).map(r => r.url.startsWith("/") ? `${ROOT}/public${r.url}` : r.url);
    const imgPath = `${imagesDir}/scene_${String(scene.index).padStart(3, "0")}.png`;
    try {
      const url = await generateRetry(scene.imagePrompt, refs, scene.index);
      await downloadTo(url, imgPath);
      ok++;
      console.log(`[wan] ✓ scene ${scene.index}`);
    } catch (err) { fail++; console.warn(`[wan] ✗ scene ${scene.index}: ${err.message.slice(0, 120)}`); }
  }));
  if (i + CONCURRENCY < targets.length) await new Promise(r => setTimeout(r, BATCH_SLEEP_MS));
}
console.log(`[wan] done: ${ok} ok, ${fail} failed`);
