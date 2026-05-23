#!/usr/bin/env node
/**
 * gen-earth-evolution.mjs — generation images + videos pour earth_evolution_prompts.json
 *
 * Usage :
 *   node scripts/gen-earth-evolution.mjs images [count=5] [startIndex=0]
 *   node scripts/gen-earth-evolution.mjs videos [count=5] [startIndex=0]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { fal } from "@fal-ai/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JSON_PATH = path.join(ROOT, "earth_evolution_prompts.json");
const OUT_DIR = path.join(ROOT, "public/generated/earth_evolution");
const IMG_DIR = path.join(OUT_DIR, "images");
const CLIP_DIR = path.join(OUT_DIR, "clips");

function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}
function loadSettings() {
  const cfgPath = path.join(ROOT, "config/settings.json");
  if (!existsSync(cfgPath)) return {};
  return JSON.parse(readFileSync(cfgPath, "utf-8"));
}
function loadFalKey() {
  return process.env.FAL_KEY || loadEnvLocal().FAL_KEY || loadSettings().falKey
    || (() => { throw new Error("FAL_KEY manquante"); })();
}
function loadWaveSpeedKey() {
  return process.env.WAVESPEED_API_KEY || loadEnvLocal().WAVESPEED_API_KEY || loadSettings().wavespeedKey
    || (() => { throw new Error("WAVESPEED_API_KEY manquante"); })();
}

const HAILUO_I2V_MODEL = "fal-ai/minimax/hailuo-02-fast/image-to-video";
const WAVESPEED_HOST = "api.wavespeed.ai";
const WAN_T2I_PATH = "/api/v3/alibaba/wan-2.5/text-to-image";
const WAVESPEED_RESULT_PATH = (id) => `/api/v3/predictions/${id}/result`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsPost(host, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: urlPath, method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error("HTTP POST timeout")); });
    if (body) req.write(body);
    req.end();
  });
}
function httpsGetJson(host, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: host, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}
function httpsDownload(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "FreedomFactory/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function generateImage(entry) {
  const idx = entry.n;
  const out = path.join(IMG_DIR, `scene_${String(idx).padStart(3, "0")}.png`);
  if (existsSync(out)) {
    console.log(`[img ${idx}] deja present -> skip`);
    return out;
  }
  console.log(`[img ${idx}] WaveSpeed wan-2.5/t2i: ${entry.epoch}`);
  const wsKey = loadWaveSpeedKey();
  const body = JSON.stringify({
    prompt: entry.image_prompt,
    negative_prompt: "low quality, blurry, distorted, deformed, watermark, text, logo, signature",
    seed: 42 + idx,
    size: "1920*1080",
  });
  const submit = await httpsPost(WAVESPEED_HOST, WAN_T2I_PATH, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${wsKey}`,
    "content-length": Buffer.byteLength(body).toString(),
  }, body);
  if (submit.status >= 400) throw new Error(`wan submit ${submit.status}: ${submit.body.toString().slice(0, 300)}`);
  const reqId = JSON.parse(submit.body.toString()).data?.id;
  if (!reqId) throw new Error(`wan: pas d'id pour scene ${idx}`);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await httpsGetJson(WAVESPEED_HOST, WAVESPEED_RESULT_PATH(reqId), { Authorization: `Bearer ${wsKey}` });
    const inner = (JSON.parse(res.body.toString()).data) || {};
    if (inner.status === "completed") {
      const url = inner.outputs?.[0];
      if (!url) throw new Error(`wan: pas d'URL sortie scene ${idx}`);
      const buf = await httpsDownload(url);
      await writeFile(out, buf);
      console.log(`[img ${idx}] OK -> ${out} (${(buf.length / 1024 / 1024).toFixed(2)} Mo)`);
      return out;
    }
    if (inner.status === "failed") throw new Error(`wan failed scene ${idx}: ${inner.error || "unknown"}`);
  }
  throw new Error(`wan timeout scene ${idx}`);
}

async function generateVideo(entry) {
  const idx = entry.n;
  const imgPath = path.join(IMG_DIR, `scene_${String(idx).padStart(3, "0")}.png`);
  const out = path.join(CLIP_DIR, `clip_${String(idx).padStart(3, "0")}.mp4`);
  if (!existsSync(imgPath)) throw new Error(`Image manquante pour scene ${idx}: ${imgPath}`);
  if (existsSync(out)) {
    console.log(`[vid ${idx}] deja present -> skip`);
    return out;
  }
  console.log(`[vid ${idx}] upload image...`);
  const buf = await readFile(imgPath);
  const blob = new Blob([buf], { type: "image/png" });
  const imageUrl = await fal.storage.upload(blob);
  console.log(`[vid ${idx}] Hailuo 02 Fast: ${entry.epoch}`);
  const result = await fal.subscribe(HAILUO_I2V_MODEL, {
    input: {
      image_url: imageUrl,
      prompt: entry.video_prompt,
      duration: "6",
      prompt_optimizer: true,
    },
    logs: false,
  });
  const data = result.data ?? {};
  const videoUrl = data.video?.url || data.video_url || (data.videos || [])[0]?.url;
  if (!videoUrl) throw new Error(`Pas de video retournee pour scene ${idx}: ${JSON.stringify(data).slice(0, 300)}`);
  const resp = await fetch(videoUrl);
  const vbuf = Buffer.from(await resp.arrayBuffer());
  await writeFile(out, vbuf);
  console.log(`[vid ${idx}] OK -> ${out} (${(vbuf.length / 1024 / 1024).toFixed(1)} Mo)`);
  return out;
}

async function main() {
  const mode = process.argv[2];
  const count = parseInt(process.argv[3] ?? "5", 10);
  const startIndex = parseInt(process.argv[4] ?? "0", 10);
  if (!mode || !["images", "videos"].includes(mode)) {
    console.error("Usage: node scripts/gen-earth-evolution.mjs <images|videos> [count=5] [startIndex=0]");
    process.exit(1);
  }
  fal.config({ credentials: loadFalKey() });
  const entries = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
  const slice = entries.slice(startIndex, startIndex + count);
  console.log(`[earth_evolution] mode=${mode} entries ${startIndex + 1}..${startIndex + slice.length}`);

  const fn = mode === "images" ? generateImage : generateVideo;
  // Sequential — simpler logs, evite les rate-limits sur les gros volumes.
  // (Pour 5 items c'est < 1 min en images, ~5 min en videos.)
  const results = [];
  for (const entry of slice) {
    try {
      const out = await fn(entry);
      results.push({ n: entry.n, ok: true, path: out });
    } catch (err) {
      console.error(`[${mode} ${entry.n}] ECHEC:`, err.message || err);
      results.push({ n: entry.n, ok: false, error: String(err.message || err) });
    }
  }
  const summaryPath = path.join(OUT_DIR, `${mode}_summary.json`);
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\n=== SUMMARY ${mode} ===`);
  for (const r of results) console.log(r.ok ? `OK  ${r.n} -> ${r.path}` : `ERR ${r.n}: ${r.error}`);
  console.log(`Summary -> ${summaryPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
