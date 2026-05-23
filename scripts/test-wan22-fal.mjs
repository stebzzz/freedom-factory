// One-shot test: Wan 2.2 a14b image-to-image via fal.ai
// Reference image -> stylized output following the prompt.

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import https from "https";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) { console.error("FAL_KEY missing"); process.exit(1); }

const REF_PATH = "/Users/stephanezayat/Downloads/Amaury - 2026-05-17 10.44.26.jpg";
const OUT_PATH = path.resolve("outputs/wan22-test-dentiste.png");
const PROMPT = `A book labeled "1728" opens on a white background with the title "Le Chirurgien Dentiste". Hand-drawn stick-figure children's-book illustration style, bold black outlines, flat solid colors, simple shapes, same naive cartoon aesthetic as the reference image.`;

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: opts.method || "GET",
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return download(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const imgBytes = readFileSync(REF_PATH);
  const dataUri = `data:image/jpeg;base64,${imgBytes.toString("base64")}`;

  const submit = await fetchJson("https://queue.fal.run/fal-ai/wan/v2.2-a14b/image-to-image", {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: dataUri,
      prompt: PROMPT,
      num_images: 1,
      enable_safety_checker: false,
    }),
  });

  console.log("submit status:", submit.status);
  console.log("submit body:", submit.body.slice(0, 400));
  if (submit.status >= 400) process.exit(1);

  const { request_id, status_url, response_url } = JSON.parse(submit.body);
  console.log("request_id:", request_id);

  let resultUrl = response_url;
  const deadline = Date.now() + 600_000;
  let completed = false;
  while (Date.now() < deadline) {
    await sleep(4000);
    const s = await fetchJson(status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const d = JSON.parse(s.body);
    process.stdout.write(`.${d.status || "?"}`);
    if (d.status === "COMPLETED") { completed = true; break; }
    if (d.status === "FAILED") { console.error("\nFAILED:", s.body); process.exit(1); }
  }
  console.log();
  if (!completed) { console.error("timeout after 10min"); process.exit(1); }

  const r = await fetchJson(resultUrl, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const data = JSON.parse(r.body);
  const url = data.images?.[0]?.url || data.image?.url;
  if (!url) { console.error("no image url:", r.body.slice(0, 400)); process.exit(1); }

  const buf = await download(url);
  writeFileSync(OUT_PATH, buf);
  console.log("saved:", OUT_PATH, `(${buf.length} bytes)`);
  console.log("fal url:", url);
})();
