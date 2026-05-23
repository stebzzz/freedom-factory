#!/usr/bin/env node
// Prep a job: segment script.txt verbatim, allocate STICK/SETTING/OBJECT (30/40/30),
// round-robin pick refs per category with reuse cap. Writes prep.json.
// Usage: node prep-job.mjs <jobDir>

import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const ROOT = "/Users/stephanezayat/Documents/youtube-freedom-factory";
const KIT_SLUG = "style-kit-def";
const jobDir = process.argv[2];
if (!jobDir || !existsSync(`${jobDir}/script.txt`)) { console.error("usage: <jobDir-with-script.txt>"); process.exit(1); }

function segmentScriptVerbatim(text) {
  const TARGET = 2, MIN = 1, MAX = 3;
  const norm = text.replace(/\s+/g, " ").trim();
  const chunks = []; let cur = "";
  const isDigit = (c) => c >= "0" && c <= "9";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i]; cur += ch;
    if (".!?;,".includes(ch)) {
      const p = norm[i - 1], n = norm[i + 1];
      if ((ch === "," || ch === ".") && p && n && isDigit(p) && isDigit(n)) continue;
      while (i + 1 < norm.length && `"'’”»`.includes(norm[i + 1])) { cur += norm[i + 1]; i++; }
      while (i + 1 < norm.length && norm[i + 1] === " ") i++;
      const t = cur.trim(); if (t) chunks.push(t); cur = "";
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  const segs = []; let buf = "", bw = 0;
  const flush = () => {
    if (!buf.trim()) return;
    const n = buf.trim();
    const w = n.split(/\s+/).filter(Boolean).length;
    const s = w / 2.5;
    segs.push({ narration: n, durationSeconds: s < 1.25 ? 1 : s < 1.75 ? 1.5 : 2 });
    buf = ""; bw = 0;
  };
  for (const ch of chunks) {
    const w = ch.split(/\s+/).filter(Boolean).length;
    if (w > MAX) {
      const m = buf.trim() ? `${buf.trim()} ${ch}` : ch; buf = ""; bw = 0;
      const tw = m.split(/\s+/).filter(Boolean).length;
      const sr = tw / 2.5;
      segs.push({ narration: m, durationSeconds: sr < 1.25 ? 1 : sr < 1.75 ? 1.5 : 2 });
      continue;
    }
    if (buf && bw + w > MAX && bw >= MIN) { flush(); buf = ch; bw = w; }
    else { buf = buf ? `${buf} ${ch}` : ch; bw += w; if (bw >= TARGET) flush(); }
  }
  if (buf.trim()) {
    if (segs.length > 0 && bw < MIN) {
      const last = segs.pop();
      const m = `${last.narration} ${buf.trim()}`;
      const w = m.split(/\s+/).filter(Boolean).length;
      const s = w / 2.5;
      segs.push({ narration: m, durationSeconds: s < 1.25 ? 1 : s < 1.75 ? 1.5 : 2 });
    } else flush();
  }
  return segs;
}

const SETTING_TOKENS = /\b(cave|campfire|hill|mountain|forest|river|beach|stone circle|tent|landscape|outdoor|ground|earth|grass|sand|night sky|stars in|sea|shore|trail|cliff|rock|desert|jungle|snow|horizon|street|alley|village|market|fountain|temple|church|castle|courtyard|garden|farm|barn|workshop|factory|tower|bridge|harbor|valley|meadow|prairie|tundra|swamp|cathedral|monastery|library|stage|amphitheater|colosseum|piazza|boulevard|square|hut|cabin|tent|stadium|arena)\b/i;
function classify(p) {
  const low = p.toLowerCase();
  const sticks = (low.match(/stickman|stick figure/g) ?? []).length;
  if (sticks === 0) return "OBJECT";
  if (SETTING_TOKENS.test(low)) return "SETTING";
  return "STICK";
}

function allocate(n) {
  // 10% STICK / 60% SETTING / 30% OBJECT — minimize plain-white-background scenes,
  // push everything else into a visible setting/landscape so the visuals breathe.
  const t = { STICK: Math.round(n * 0.10), SETTING: Math.round(n * 0.60), OBJECT: 0 };
  t.OBJECT = n - t.STICK - t.SETTING;
  // Build a flat array with all categories then shuffle with seeded RNG for spread.
  const arr = [];
  for (let i = 0; i < t.STICK; i++) arr.push("STICK");
  for (let i = 0; i < t.SETTING; i++) arr.push("SETTING");
  for (let i = 0; i < t.OBJECT; i++) arr.push("OBJECT");
  // Seeded shuffle (deterministic for same n)
  let seed = 0x12345 ^ n;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  // Post-pass: fix any two-in-a-row by swapping with a nearby different category.
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1]) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j] !== arr[i - 1] && (j + 1 >= arr.length || arr[j + 1] !== arr[i])) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
  return arr;
}

const text = (await fs.readFile(`${jobDir}/script.txt`, "utf-8")).trim();
const segments = segmentScriptVerbatim(text);
console.log(`[${path.basename(jobDir)}] segments: ${segments.length}`);

const meta = JSON.parse(await fs.readFile(`${ROOT}/public/style-refs/${KIT_SLUG}/meta.json`, "utf-8"));
const allRefs = [...(meta.character || []), ...(meta.style || [])].filter(r => r.imagePrompt);
const buckets = { STICK: [], SETTING: [], OBJECT: [] };
for (const r of allRefs) buckets[classify(r.imagePrompt)].push({ filename: r.filename, tag: r.tag, imagePrompt: r.imagePrompt });

const cats = allocate(segments.length);
const usage = new Map();
const pickIdx = { STICK: 0, SETTING: 0, OBJECT: 0 };
const stickPure = "frame-005.png";
function pickRef(cat) {
  if (cat === "STICK") return null;
  const bucket = buckets[cat];
  if (bucket.length === 0) return null;
  const target = cats.filter(c => c === cat).length;
  const cap = Math.max(2, Math.ceil(target / bucket.length) + 1);
  for (let tries = 0; tries < bucket.length; tries++) {
    const r = bucket[(pickIdx[cat] + tries) % bucket.length];
    if ((usage.get(r.filename) ?? 0) < cap) {
      pickIdx[cat] = (pickIdx[cat] + tries + 1) % bucket.length;
      usage.set(r.filename, (usage.get(r.filename) ?? 0) + 1);
      return r;
    }
  }
  const r = bucket[pickIdx[cat] % bucket.length];
  pickIdx[cat]++;
  usage.set(r.filename, (usage.get(r.filename) ?? 0) + 1);
  return r;
}

const prep = segments.map((seg, i) => ({
  index: i, narration: seg.narration, durationSeconds: seg.durationSeconds,
  category: cats[i],
  kitRef: cats[i] === "STICK" ? null : pickRef(cats[i]),
  canonicalStick: stickPure,
}));

await fs.writeFile(`${jobDir}/prep.json`, JSON.stringify({
  kit: KIT_SLUG, totalScenes: segments.length,
  allocation: { STICK: cats.filter(c=>c==="STICK").length, SETTING: cats.filter(c=>c==="SETTING").length, OBJECT: cats.filter(c=>c==="OBJECT").length },
  fullScript: text, scenes: prep,
}, null, 2));
console.log(`[${path.basename(jobDir)}] ✓ prep | STICK=${prep.filter(p=>p.category==="STICK").length} SETTING=${prep.filter(p=>p.category==="SETTING").length} OBJECT=${prep.filter(p=>p.category==="OBJECT").length} | kit buckets: STICK=${buckets.STICK.length} SETTING=${buckets.SETTING.length} OBJECT=${buckets.OBJECT.length}`);
