#!/usr/bin/env node
// finish-genaipro-earth.mjs — termine la génération images earth_evolution :
//   - waits for in-flight task c9b68e45-... (row 17) and downloads it
//   - POSTs create-image for rows 25, 38 then polls + downloads
// Utilise la nouvelle URL CDN genaipro.io/files/.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROMPTS_PATH = path.join(ROOT, "earth_evolution_prompts.json");
const OUT_DIR = path.join(ROOT, "public/generated/earth_evolution_genaipro");
const IMG_DIR = path.join(OUT_DIR, "images");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");

const API_HOST = "genaipro.io";
const CDN_HOST = "genaipro.io";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "nano_banana_pro";
const POLL_INTERVAL_MS = 15000;

// 25 already completed (e60c933c), 17 zombie since hours, 38 failed → re-POST 17 et 38, just DL 25.
const ALREADY_DONE = [{ row: 25, taskId: "e60c933c-805a-4857-844e-c3f42965ed09" }];
const IN_FLIGHT = [];
const TO_REGEN = [17, 38];

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
function loadKey() {
  const k = process.env.GENAIPRO_API_KEY || loadEnvLocal().GENAIPRO_API_KEY;
  if (!k) { console.error("GENAIPRO_API_KEY manquante"); process.exit(1); }
  return k;
}

function httpsRequest(method, host, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: urlPath, method, headers }, (res) => {
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

function buildMultipart(fields) {
  const boundary = `----GenAIPro${randomBytes(8).toString("hex")}`;
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function rewriteCdnUrl(url) {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  if (m) return `https://${CDN_HOST}/files/${m[1]}`;
  return url;
}
function detectExt(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "png";
  return "png";
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

async function createImage(token, prompt) {
  const { body, contentType } = buildMultipart([
    ["prompt", prompt],
    ["aspect_ratio", "IMAGE_ASPECT_RATIO_LANDSCAPE"],
    ["number_of_images", "1"],
    ["model", IMAGE_MODEL],
  ]);
  const res = await httpsRequest("POST", API_HOST, "/api/v2/veo/create-image", {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "Content-Length": body.length,
  }, body);
  if (res.status !== 202) {
    throw new Error(`create-image ${res.status}: ${res.body.toString().slice(0, 400)}`);
  }
  return JSON.parse(res.body.toString());
}

async function pollUntilDone(token, taskIds) {
  const pending = new Set(taskIds);
  const results = new Map();
  const start = Date.now();
  const TIMEOUT = 1200_000;
  let cycle = 0;
  while (pending.size > 0) {
    if (Date.now() - start > TIMEOUT) {
      console.log(`\nTIMEOUT — ${pending.size} pending: ${[...pending].join(", ")}`);
      break;
    }
    let pg = 1;
    while (pending.size > 0) {
      const r = await httpsRequest("GET", API_HOST,
        `/api/v2/veo/histories?page=${pg}&page_size=100`,
        { Authorization: `Bearer ${token}` });
      if (r.status !== 200) throw new Error(`histories ${r.status}`);
      const j = JSON.parse(r.body.toString());
      for (const item of j.data || []) {
        if (!pending.has(item.id)) continue;
        if (item.status === "completed" || item.status === "failed") {
          results.set(item.id, item);
          pending.delete(item.id);
        }
      }
      const total = j.total_pages || 1;
      if (pg >= total) break;
      pg++;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r[poll] done=${results.size} pending=${pending.size} (${elapsed}s, cycle ${++cycle})    `);
    if (pending.size === 0) break;
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write("\n");
  return results;
}

async function downloadAndSave(item, row, prompts, manifest) {
  const url = rewriteCdnUrl(item.file_urls[0]);
  const m = url.match(/^https?:\/\/([^\/]+)(\/.*)$/);
  const r = await httpsRequest("GET", m[1], m[2], {});
  if (r.status !== 200) throw new Error(`download ${r.status}`);
  const buf = r.body;
  const ext = detectExt(buf);
  const fname = `${String(row.n).padStart(2, "0")}_${slug(row.epoch)}.${ext}`;
  const fpath = path.join(IMG_DIR, fname);
  await writeFile(fpath, buf);
  console.log(`OK row ${row.n} -> ${fname} (${(buf.length / 1024).toFixed(0)} KB)`);
  const existing = manifest.entries.find((e) => e.n === row.n);
  const entry = existing || { n: row.n, epoch: row.epoch };
  entry.image = { taskId: item.id, url, path: fpath };
  if (!existing) manifest.entries.push(entry);
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

async function main() {
  mkdirSync(IMG_DIR, { recursive: true });
  const token = loadKey();
  const prompts = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))
    : { entries: [] };

  // POST create-image pour les rows à régénérer
  const taskMap = new Map(); // taskId -> row
  for (const inflt of IN_FLIGHT) {
    const row = prompts.find((p) => p.n === inflt.row);
    taskMap.set(inflt.taskId, row);
    console.log(`[in-flight] row ${row.n} task ${inflt.taskId}`);
  }
  for (const n of TO_REGEN) {
    const row = prompts.find((p) => p.n === n);
    console.log(`[regen] POST row ${n} (${row.epoch})`);
    const t = await createImage(token, row.image_prompt);
    console.log(`[regen] row ${n} -> task ${t.id}`);
    taskMap.set(t.id, row);
  }

  console.log(`\n[poll] polling ${taskMap.size} task(s)...`);
  const results = await pollUntilDone(token, [...taskMap.keys()]);

  console.log(`\n[download] downloading...`);
  const ok = [], failed = [];
  for (const [taskId, row] of taskMap) {
    const item = results.get(taskId);
    if (!item) { console.log(`STUCK row ${row.n} task ${taskId}`); failed.push(row.n); continue; }
    if (item.status !== "completed") { console.log(`FAIL row ${row.n}: ${item.status}`); failed.push(row.n); continue; }
    if (!item.file_urls?.[0]) { console.log(`NO URL row ${row.n}`); failed.push(row.n); continue; }
    try {
      await downloadAndSave(item, row, prompts, manifest);
      ok.push(row.n);
    } catch (e) {
      console.log(`DL FAIL row ${row.n}: ${e.message}`);
      failed.push(row.n);
    }
  }
  console.log(`\n=== DONE ===`);
  console.log(`OK (${ok.length}): ${ok.join(", ")}`);
  if (failed.length) console.log(`FAILED (${failed.length}): ${failed.join(", ")}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
