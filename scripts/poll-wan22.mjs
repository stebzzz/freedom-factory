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
const REQ = "019e358b-9d87-71b2-af46-0f319d6cf753";
const STATUS = `https://queue.fal.run/fal-ai/wan/requests/${REQ}/status`;
const RESP = `https://queue.fal.run/fal-ai/wan/requests/${REQ}`;
const OUT = path.resolve("outputs/wan22-test-dentiste.png");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname, headers: { Authorization: `Key ${FAL_KEY}` } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    }).on("error", reject);
  });
}
function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return download(res.headers.location).then(resolve).catch(reject);
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => resolve(Buffer.concat(c)));
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const s = await fetchJson(STATUS);
    const d = JSON.parse(s.body);
    console.log(new Date().toISOString(), d.status);
    if (d.status === "COMPLETED") {
      const r = await fetchJson(RESP);
      const data = JSON.parse(r.body);
      console.log("response keys:", Object.keys(data));
      const url = data.images?.[0]?.url || data.image?.url;
      if (!url) { console.error("no image:", r.body.slice(0, 400)); process.exit(1); }
      const buf = await download(url);
      writeFileSync(OUT, buf);
      console.log("saved:", OUT, buf.length, "bytes");
      console.log("fal url:", url);
      process.exit(0);
    }
    if (d.status === "FAILED") { console.error("FAILED:", s.body); process.exit(1); }
    await sleep(6000);
  }
  console.error("timeout"); process.exit(1);
})();
