#!/usr/bin/env node
// Read prep.json, build remix prompt, pipe to `claude -p`, parse with regex fallback,
// write script.json + refs-mapping.json. Usage: node gen-prompts.mjs <jobDir>

import fs from "fs/promises";
import { spawnSync } from "child_process";
import path from "path";
import { existsSync } from "fs";

const ROOT = "/Users/stephanezayat/Documents/youtube-freedom-factory";
const jobDir = process.argv[2];
if (!jobDir || !existsSync(`${jobDir}/prep.json`)) { console.error("usage: <jobDir-with-prep.json>"); process.exit(1); }

const prep = JSON.parse(await fs.readFile(`${jobDir}/prep.json`, "utf-8"));
const KIT_SLUG = prep.kit;
const meta = JSON.parse(await fs.readFile(`${ROOT}/public/style-refs/${KIT_SLUG}/meta.json`, "utf-8"));
const allRefs = [...(meta.character || []), ...(meta.style || [])].filter(r => r.imagePrompt);

const SETTING_TOKENS = /\b(cave|campfire|hill|mountain|forest|river|beach|stone circle|tent|landscape|outdoor|ground|earth|grass|sand|night sky|stars in|sea|shore|trail|cliff|rock|desert|jungle|snow|horizon|street|alley|village|market|fountain|temple|church|castle|courtyard|garden|farm|barn|workshop|factory|tower|bridge|harbor|valley|meadow|prairie|tundra|swamp|cathedral|monastery|library|stage|amphitheater|colosseum|piazza|boulevard|square|hut|cabin|tent|stadium|arena)\b/i;
function classify(p) {
  const low = p.toLowerCase();
  const sticks = (low.match(/stickman|stick figure/g) ?? []).length;
  if (sticks === 0) return "OBJECT";
  if (SETTING_TOKENS.test(low)) return "SETTING";
  return "STICK";
}
const buckets = { STICK: [], SETTING: [], OBJECT: [] };
allRefs.forEach((r, i) => buckets[classify(r.imagePrompt)].push({ idx: i, filename: r.filename, text: r.imagePrompt }));

const bucketList = (cat) => buckets[cat].length === 0
  ? "(empty — compose from scratch; use kitBaseIndex: null)"
  : buckets[cat].map(b => `[K${b.idx}] ${b.text}`).join("\n");

const numbered = prep.scenes.map(s => `${s.index} [${s.category}]: ${s.narration}`).join("\n");

function buildPrompt(chunkScenes) {
  const numberedChunk = chunkScenes.map(s => `${s.index} [${s.category}]: ${s.narration}`).join("\n");
  return `You are a prompt remixer for stickman-style explainer-video frames. Each pre-segmented narration beat has a FORCED visual category (STICK / SETTING / OBJECT).

═══════════════════════════
CATEGORY DEFINITIONS
═══════════════════════════
STICK   = ONE stickman alone, distinct action, plain white background. NO scenery, NO labels.
SETTING = ONE stickman in a LANDSCAPE/ENVIRONMENT (cave, beach, hill, forest, street, village, market, campfire, mountain). Environment visible.
OBJECT  = NO stickman. Pure object/symbol (candle, timeline, gear, calendar, chart, map).

═══════════════════════════
KIT PROMPTS by category
═══════════════════════════
--- STICK (${buckets.STICK.length}) ---
${bucketList("STICK")}

--- SETTING (${buckets.SETTING.length}) ---
${bucketList("SETTING")}

--- OBJECT (${buckets.OBJECT.length}) ---
${bucketList("OBJECT")}

═══════════════════════════
RULES
═══════════════════════════
1. Pick a kit prompt from the matching category bucket; edit minimally.
2. SETTING: VARY the landscape across consecutive scenes (cave then hill then market).
3. STICK: ALWAYS NEW pose/action. Never two identical poses consecutively.
4. Vary kit picks — avoid same K-index within 5 consecutive scenes.
5. RESPECT category strictly. 18-35 words. One English sentence.
6. NEVER output kit verbatim; NEVER illustrate transitional sentences literally.

═══════════════════════════
TASK
═══════════════════════════
Generate EXACTLY ${chunkScenes.length} prompts for these specific scene indices. Output strict JSON only:

{"prompts":[
  {"index": <idx>, "category": "STICK|SETTING|OBJECT", "kitBaseIndex": <K or null>, "imagePrompt": "<remixed sentence>"}
]}

═══════════════════════════
NARRATIONS (verbatim, FORCED category in brackets)
═══════════════════════════
${numberedChunk}

═══════════════════════════
FULL SCRIPT (context only)
═══════════════════════════
${prep.fullScript}`;
}

// Chunk in batches of 50 (Claude reliably produces ~50 prompts in one response)
const CHUNK_SIZE = 50;
const chunks = [];
for (let i = 0; i < prep.scenes.length; i += CHUNK_SIZE) {
  chunks.push(prep.scenes.slice(i, i + CHUNK_SIZE));
}
console.log(`[${path.basename(jobDir)}] ${prep.scenes.length} scenes → ${chunks.length} chunks de ${CHUNK_SIZE}`);

const promptsByIdx = new Map();

async function processChunk(chunkScenes, chunkIdx) {
  const PROMPT = buildPrompt(chunkScenes);
  const t0 = Date.now();
  const res = spawnSync("claude", ["-p"], {
    input: PROMPT, maxBuffer: 50 * 1024 * 1024, encoding: "utf-8",
  });
  console.log(`[${path.basename(jobDir)}] chunk ${chunkIdx + 1}/${chunks.length} exit ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (res.status !== 0) { console.warn("stderr:", res.stderr?.slice(0, 300)); return 0; }
  const raw = (res.stdout || "").trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let got = 0;
  try {
    const parsed = JSON.parse(stripped);
    for (const p of parsed.prompts ?? []) {
      if (typeof p.index === "number" && typeof p.imagePrompt === "string") { promptsByIdx.set(p.index, p.imagePrompt.trim()); got++; }
    }
  } catch {
    const re = /\{\s*"index"\s*:\s*(\d+)[\s\S]*?"imagePrompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const idx = parseInt(m[1], 10);
      const text = m[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
      if (text) { promptsByIdx.set(idx, text); got++; }
    }
  }
  return got;
}

// Sequential chunks (claude -p is heavy, no parallel)
for (let i = 0; i < chunks.length; i++) {
  const got = await processChunk(chunks[i], i);
  console.log(`[${path.basename(jobDir)}] chunk ${i + 1}/${chunks.length}: ${got} prompts`);
}

// Retry missing scenes up to 2 more times — no fallback allowed.
for (let retry = 1; retry <= 2; retry++) {
  const missing = prep.scenes.filter(s => !promptsByIdx.has(s.index));
  if (missing.length === 0) break;
  console.log(`[${path.basename(jobDir)}] retry ${retry}/2: ${missing.length} missing indices: ${missing.slice(0,10).map(s=>s.index).join(",")}...`);
  // Chunk the missing list in batches of 50
  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    const slice = missing.slice(i, i + CHUNK_SIZE);
    await processChunk(slice, `retry${retry}-${i}`);
  }
}

const stillMissing = prep.scenes.filter(s => !promptsByIdx.has(s.index));
if (stillMissing.length > 0) {
  console.error(`[${path.basename(jobDir)}] FAIL: ${stillMissing.length} scenes still missing after retries. ABORT (no fallback).`);
  process.exit(1);
}
console.log(`[${path.basename(jobDir)}] total: ${promptsByIdx.size}/${prep.scenes.length} prompts ✓ NO FALLBACK`);

const publicPrefix = `${ROOT}/public/`;
const toUrl = (abs) => abs.startsWith(publicPrefix) ? "/" + abs.slice(publicPrefix.length) : abs;
const canonicalStickAbs = `${ROOT}/public/style-refs/${KIT_SLUG}/style/${prep.scenes[0].canonicalStick}`;

const scenes = prep.scenes.map((s) => ({
  index: s.index, narration: s.narration,
  imagePrompt: promptsByIdx.get(s.index) ?? `Single stickman scene ${s.index}, plain white background.`,
  durationSeconds: s.durationSeconds,
}));

const norm = (x) => x.replace(/\s+/g, " ").trim();
const reconstructed = norm(scenes.map(x => x.narration).join(" "));
const original = norm(prep.scenes.map(s => s.narration).join(" "));
if (reconstructed !== original) { console.error("narration diverged"); process.exit(1); }

await fs.writeFile(`${jobDir}/script.json`, JSON.stringify({
  title: path.basename(jobDir), niche: "Histoire",
  wordCount: prep.fullScript.split(/\s+/).length, scenes,
}, null, 2));

const mappingRows = prep.scenes.map((s, i) => {
  const wantsStick = /stickman|stick figure/i.test(scenes[i].imagePrompt);
  const refs = [];
  if (s.category === "STICK") {
    refs.push({ filename: prep.scenes[0].canonicalStick, url: toUrl(canonicalStickAbs) });
  } else if (s.kitRef) {
    const refAbs = `${ROOT}/public/style-refs/${KIT_SLUG}/${s.kitRef.tag}/${s.kitRef.filename}`;
    if (wantsStick) refs.push({ filename: prep.scenes[0].canonicalStick, url: toUrl(canonicalStickAbs) });
    refs.push({ filename: s.kitRef.filename, url: toUrl(refAbs) });
  } else if (wantsStick) {
    refs.push({ filename: prep.scenes[0].canonicalStick, url: toUrl(canonicalStickAbs) });
  }
  return {
    sceneIndex: s.index, narration: s.narration, imagePrompt: scenes[i].imagePrompt,
    category: s.category, refs,
    candidates: s.kitRef ? [{ filename: s.kitRef.filename, url: toUrl(`${ROOT}/public/style-refs/${KIT_SLUG}/${s.kitRef.tag}/${s.kitRef.filename}`) }] : [],
  };
});
await fs.writeFile(`${jobDir}/refs-mapping.json`, JSON.stringify({
  kit: KIT_SLUG, topN: 1, antiDuplicate: true, canonicalStick: true, scenes: mappingRows,
}, null, 2));

console.log(`[${path.basename(jobDir)}] ✓ script.json + refs-mapping.json`);
