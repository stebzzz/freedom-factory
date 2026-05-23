#!/usr/bin/env node
// gen-galveston-wharf-t2v.mjs — text-to-video Veo V2 du wharf Galveston 1900.
// Pattern recopié de scripts/animate-genaipro-earth.mjs (poll /v2/veo/histories,
// CDN rewrite files.genaipro.vn -> genaipro.io/files/).
//
// Usage :
//   GENAIPRO_TOKEN="eyJ..." node scripts/gen-galveston-wharf-t2v.mjs
//   (sinon fallback sur GENAIPRO_API_KEY de .env.local)

import { existsSync, readFileSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCENE = process.env.SCENE || "wharf_dawn";
const OUT_DIR = path.join(ROOT, "public/generated/galveston_1900/scenes_t2v");
const API_HOST = "genaipro.io";
const API_BASE = "/api";
const ASPECT = "VIDEO_ASPECT_RATIO_LANDSCAPE";
const POLL_INTERVAL_MS = 15000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const PROMPTS = {
  wharf_dawn: `A sweeping cinematic crane shot rising slowly over the bustling Galveston wharf at early morning, September 8th 1900. The frame opens on towering pyramids of burlap-wrapped cotton bales stacked three stories high along the wooden dock. The camera ascends and reveals a forest of ship masts and tall black smokestacks: a massive black-hulled steamship labeled "S.S. ATLANTIC – GALVESTON TO LIVERPOOL" with American flag fluttering, surrounded by tall-masted sailing vessels and other steamships from multiple nations, dark coal smoke billowing from their funnels. Dockworkers in rolled-up shirtsleeves, suspenders, and flat caps load cotton bales onto cargo nets via a steam-powered crane swinging slowly across the frame. The wood of the dock is wet with morning mist. Wagons drawn by draft horses haul more bales toward the ships. Atmosphere: industrial empire at its peak, the world's leading cotton port. Photorealistic period-accurate 1900, cinematic anamorphic lens, soft humid overcast morning light, slight haze, rich earthy color palette of browns, greys, and burlap tan, 16:9 cinematic aspect ratio. Audio: rhythmic creaking of the crane, clop of draft horses, dockworkers shouting orders in heavy Southern accents, hiss of steam from a funnel, gulls crying overhead, distant ship horns, no music, no dialogue closeup. Duration: 8 seconds. No modern objects, no anachronisms.`,

  rooftop_sunrise: `A slow cinematic dolly-up shot rising over the rooftops of Galveston, Texas at the exact moment of sunrise, September 8th 1900. The first golden rays break over the horizon line of the Gulf of Mexico, casting long warm light across the slate roofs and ornate Victorian turrets of the city. Wisps of low morning mist drift between chimneys. A few birds take flight across frame. The camera rises smoothly, revealing more of the silhouetted skyline against a sky transitioning from deep indigo to amber. Atmosphere: dawn, peaceful, monumental, the calm before catastrophe. Photorealistic period-accurate 1900, shot on Arri Alexa 65 with vintage anamorphic lens, deep cinematic color grading, 16:9 cinematic aspect ratio. Audio: distant rooster crow, faint church bell tolling once, soft wind, no music. Duration: 4 seconds. No modern objects, no anachronisms.`,
};
const PROMPT = PROMPTS[SCENE];
if (!PROMPT) { console.error(`SCENE inconnue: ${SCENE}. Disponibles: ${Object.keys(PROMPTS).join(", ")}`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!existsSync(p)) return {};
  const o = {};
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return o;
}
function loadToken() {
  const env = loadEnvLocal();
  const k = process.env.GENAIPRO_TOKEN || process.env.GENAIPRO_API_KEY || env.GENAIPRO_API_KEY;
  if (!k) {
    console.error("GENAIPRO_TOKEN ou GENAIPRO_API_KEY manquante.");
    process.exit(1);
  }
  return k;
}

function httpsRequest(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(180_000, () => { req.destroy(); reject(new Error(`HTTP ${method} timeout`)); });
    if (body) req.write(body);
    req.end();
  });
}

function rewriteCdnUrl(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}
function httpsDownload(url) {
  const target = rewriteCdnUrl(url);
  return new Promise((resolve, reject) => {
    https.get(target, { headers: { "User-Agent": "FreedomFactory/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${target}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function textToVideo(token, prompt) {
  const body = Buffer.from(JSON.stringify({
    prompt,
    aspect_ratio: ASPECT,
    number_of_videos: 1,
  }));
  const res = await httpsRequest("POST", `${API_BASE}/v2/veo/text-to-video`, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": body.length,
  }, body);
  if (res.status !== 202) {
    throw new Error(`text-to-video ${res.status}: ${res.body.toString("utf-8").slice(0, 600)}`);
  }
  const data = JSON.parse(res.body.toString("utf-8"));
  const history = data.histories?.[0];
  if (!history) throw new Error("text-to-video: no history");
  return history;
}

async function pollUntilDone(token, taskId) {
  const start = Date.now();
  let cycle = 0;
  while (true) {
    if (Date.now() - start > POLL_TIMEOUT_MS) throw new Error(`poll timeout (${POLL_TIMEOUT_MS / 1000}s)`);
    let page = 1;
    while (true) {
      const res = await httpsRequest("GET",
        `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`,
        { Authorization: `Bearer ${token}` });
      if (res.status === 429) {
        const txt = res.body.toString("utf-8");
        const m = txt.match(/(\d+)\s*Seconds?/i);
        const wait = m ? Math.max(parseInt(m[1], 10), 5) * 1000 : 15000;
        process.stdout.write(`\n[poll] 429 -> sleep ${wait / 1000}s\n`);
        await sleep(wait);
        continue;
      }
      if (res.status !== 200) throw new Error(`histories ${res.status}: ${res.body.toString("utf-8").slice(0, 300)}`);
      const body = JSON.parse(res.body.toString("utf-8"));
      const items = body.data || [];
      const hit = items.find((it) => it.id === taskId);
      if (hit) {
        if (hit.status === "completed") return hit;
        if (hit.status === "failed") throw new Error(`task ${taskId} failed`);
        break;
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages || items.length === 0) break;
      page++;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[poll] ${taskId.slice(0, 8)} pending (${elapsed}s, cycle ${++cycle})        `);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main() {
  const token = loadToken();
  mkdirSync(OUT_DIR, { recursive: true });

  let taskId;
  if (process.env.RESUME_TASK) {
    taskId = process.env.RESUME_TASK;
    console.log(`RESUME task ${taskId}, polling…`);
  } else {
    console.log(`POST text-to-video (${PROMPT.length} chars)`);
    const history = await textToVideo(token, PROMPT);
    taskId = history.id;
    console.log(`task ${taskId} accepté, polling…`);
  }

  const result = await pollUntilDone(token, taskId);
  process.stdout.write("\n");
  const url = result.file_urls?.[0] || result.file_url;
  if (!url) throw new Error(`no file url in result: ${JSON.stringify(result).slice(0, 300)}`);

  const buf = await httpsDownload(url);
  const fname = `${SCENE}_${taskId.slice(0, 8)}.mp4`;
  const fpath = path.join(OUT_DIR, fname);
  await writeFile(fpath, buf);
  console.log(`OK -> ${path.relative(ROOT, fpath)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
