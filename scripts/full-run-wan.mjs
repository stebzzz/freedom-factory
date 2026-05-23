#!/usr/bin/env node
// Complete an existing job by ranking all scenes against the kit then generating via WAN 2.7.
// Usage:
//   set -a && source .env.local && set +a
//   node scripts/full-run-wan.mjs <jobId>
//
// Reads:
//   - public/generated/<jobId>/script.json  (N scenes with imagePrompt)
//   - public/style-refs/<kitSlug>/meta.json (kit images with imagePrompt for describe mode)
//   - public/generated/<jobId>/refs-mapping.json (existing kit slug + already-mapped scenes)
//
// Writes:
//   - public/generated/<jobId>/refs-mapping.json (now covers ALL scenes)
//   - public/generated/<jobId>/images/scene_<idx>.png (one per scene, skip existing)

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const REF_PREFIX = "Use the image reference. Match the style of the reference image as closely as possible. ";
const REGION = (process.env.DASHSCOPE_REGION || "intl").toLowerCase();
const WAN_BASE = REGION === "cn"
  ? "https://dashscope.aliyuncs.com/api/v1"
  : "https://dashscope-intl.aliyuncs.com/api/v1";
const WAN_ENDPOINT = `${WAN_BASE}/services/aigc/multimodal-generation/generation`;
const WAN_MODEL = process.env.WAN_MODEL || "wan2.7-image";
const WAN_SIZE = "1280*720";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const TOP_N = 1;
const SUBMIT_CONCURRENCY = 3;
const SUBMIT_SPACING_MS = 2000;

const PUBLIC_GENERATED = path.join(process.cwd(), "public", "generated");
const STYLE_REFS = path.join(process.cwd(), "public", "style-refs");

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
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(target, buf);
  return buf.length;
}

/** Single Sonnet call that maps every scene to its top-N best kit refs by prompt. */
async function rankAllScenes(scenes, kitImages, anthropicKey) {
  const valid = kitImages.filter((k) => (k.imagePrompt ?? "").trim().length > 20);
  const kitBlock = valid.map((k) => `[FILE ${k.filename}]\n${k.imagePrompt.trim()}`).join("\n\n");
  const scenesBlock = scenes.map((s) => `[SCENE ${s.index}]\n${(s.imagePrompt ?? "").trim()}`).join("\n\n");

  const prompt = `Tu reçois (A) une banque de ${valid.length} images de référence — chacune décrite par un prompt image-gen détaillé — et (B) ${scenes.length} scènes de pipeline. Pour CHAQUE scène, choisis ${TOP_N} fichier(s) de la banque dont la description correspond le mieux au prompt de la scène (sujet, ambiance, médium, palette, composition).

Règles :
- Renvoie EXACTEMENT ${TOP_N} filename(s) par scène.
- Utilise UNIQUEMENT les filenames listés dans la banque (copie exacte).
- Tu peux réutiliser un même fichier sur plusieurs scènes.
- Privilégie la cohérence visuelle.

Réponds avec UN bloc JSON strict, format :
{"scenes":[{"index":<int>,"filenames":["<file>"]},...]}

=== BANQUE D'IMAGES ===
${kitBlock}

=== SCÈNES ===
${scenesBlock}`;

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: Math.min(32000, 1000 + scenes.length * (TOP_N * 40)),
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim() ?? "";
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(stripped);

  const validNames = new Set(valid.map((k) => k.filename));
  const out = [];
  for (const row of parsed.scenes ?? []) {
    if (typeof row.index !== "number") continue;
    const names = Array.isArray(row.filenames)
      ? row.filenames.filter((n) => typeof n === "string" && validNames.has(n)).slice(0, TOP_N)
      : [];
    out.push({ index: row.index, filenames: names });
  }
  return out;
}

async function wanGenerateOne(key, prompt, refPaths) {
  const content = [{ text: prompt }];
  for (const p of refPaths.slice(0, 9)) content.push({ image: await refToDataUri(p) });
  const res = await fetch(WAN_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: WAN_MODEL,
      input: { messages: [{ role: "user", content }] },
      parameters: { size: WAN_SIZE, n: 1, watermark: false },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.code) throw new Error(`WAN ${data.code ?? res.status}: ${data.message ?? "no message"}`);
  const url = data.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!url) throw new Error("WAN: no image URL");
  return url;
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) { console.error("Usage: node scripts/full-run-wan.mjs <jobId>"); process.exit(1); }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const wanKey = process.env.DASHSCOPE_API_KEY;
  if (!anthropicKey) { console.error("ANTHROPIC_API_KEY missing"); process.exit(1); }
  if (!wanKey) { console.error("DASHSCOPE_API_KEY missing"); process.exit(1); }

  const jobDir = path.join(PUBLIC_GENERATED, jobId);
  const imagesDir = path.join(jobDir, "images");
  await mkdir(imagesDir, { recursive: true });

  // 1) Load script + existing refs-mapping to discover kit slug.
  const script = JSON.parse(await readFile(path.join(jobDir, "script.json"), "utf-8"));
  const scenes = script.scenes ?? [];
  console.log(`Job has ${scenes.length} scenes`);

  let kitSlug;
  try {
    const existing = JSON.parse(await readFile(path.join(jobDir, "refs-mapping.json"), "utf-8"));
    kitSlug = existing.kit;
  } catch { /* no mapping yet */ }
  if (!kitSlug) {
    console.error("Cannot detect kit slug (no refs-mapping.json) — abort. Run a pilot first or provide kit manually.");
    process.exit(1);
  }
  const kitDir = path.join(STYLE_REFS, kitSlug);
  const kitMeta = JSON.parse(await readFile(path.join(kitDir, "meta.json"), "utf-8"));
  const kitImages = [...(kitMeta.character ?? []), ...(kitMeta.style ?? [])];
  console.log(`Kit '${kitSlug}': ${kitImages.length} refs`);

  // 2) Rank ALL scenes (one Sonnet call).
  console.log(`\n>>> Ranking ${scenes.length} scenes via Sonnet (1 call)...`);
  const t0 = Date.now();
  const ranking = await rankAllScenes(scenes, kitImages, anthropicKey);
  console.log(`>>> Ranked in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${ranking.length}/${scenes.length} scenes mapped`);

  // Build map sceneIndex -> [absolute paths]
  const pathFor = (filename) => {
    const found = kitImages.find((i) => i.filename === filename);
    if (!found) return "";
    return path.join(kitDir, found.tag, filename);
  };
  const refsByScene = new Map();
  for (const row of ranking) {
    const paths = row.filenames.map(pathFor).filter(Boolean);
    refsByScene.set(row.index, paths);
  }

  // 3) Persist refs-mapping.json (overwrite).
  const publicPrefix = path.join(process.cwd(), "public") + path.sep;
  const toPublicUrl = (absPath) =>
    absPath.startsWith(publicPrefix) ? "/" + absPath.slice(publicPrefix.length).split(path.sep).join("/") : absPath;
  const mappingRows = scenes.map((s) => {
    const refPaths = refsByScene.get(s.index) ?? [];
    return {
      sceneIndex: s.index,
      narration: s.narration,
      imagePrompt: s.imagePrompt,
      refs: refPaths.map((p) => ({ filename: path.basename(p), url: toPublicUrl(p) })),
    };
  });
  await writeFile(
    path.join(jobDir, "refs-mapping.json"),
    JSON.stringify({ kit: kitSlug, topN: TOP_N, scenes: mappingRows }, null, 2),
  );
  console.log(`>>> refs-mapping.json written (${mappingRows.length} scenes)`);

  // 4) Generate images for all scenes (skip those already on disk).
  const todo = [];
  let skipped = 0;
  for (const s of scenes) {
    const target = path.join(imagesDir, `scene_${String(s.index).padStart(3, "0")}.png`);
    try { await stat(target); skipped += 1; }
    catch { todo.push({ scene: s, target }); }
  }
  console.log(`\n>>> WAN ${WAN_MODEL} — ${todo.length} to generate, ${skipped} already on disk`);
  console.log(`>>> concurrency=${SUBMIT_CONCURRENCY}, spacing=${SUBMIT_SPACING_MS}ms — ETA ≈ ${Math.ceil(todo.length / SUBMIT_CONCURRENCY * 10 / 60)} min`);

  const stats = { ok: 0, fail: 0 };
  const tWan = Date.now();
  for (let i = 0; i < todo.length; i += SUBMIT_CONCURRENCY) {
    const batch = todo.slice(i, i + SUBMIT_CONCURRENCY);
    await Promise.all(batch.map(async ({ scene, target }) => {
      const refs = refsByScene.get(scene.index) ?? [];
      const prompt = `${REF_PREFIX}${scene.imagePrompt}`;
      const t0 = Date.now();
      try {
        const url = await wanGenerateOne(wanKey, prompt, refs);
        const bytes = await downloadTo(url, target);
        console.log(`  [${i+batch.indexOf({scene,target})+1+skipped}/${scenes.length}] scene ${scene.index} ✓ (${(bytes/1024).toFixed(0)} kB, ${((Date.now()-t0)/1000).toFixed(1)}s)`);
        stats.ok += 1;
      } catch (err) {
        console.warn(`  scene ${scene.index} FAILED: ${err.message.slice(0, 160)}`);
        stats.fail += 1;
      }
    }));
    if (i + SUBMIT_CONCURRENCY < todo.length) {
      await new Promise((r) => setTimeout(r, SUBMIT_SPACING_MS));
    }
    // Progress heartbeat every 30 scenes
    if ((i / SUBMIT_CONCURRENCY) % 10 === 0 && i > 0) {
      const done = stats.ok + stats.fail;
      const elapsed = (Date.now() - tWan) / 1000;
      const rate = done / elapsed;
      const remaining = Math.ceil((todo.length - done) / rate);
      console.log(`  [hb] ${done}/${todo.length} (${stats.ok} ok / ${stats.fail} fail) · ${elapsed.toFixed(0)}s elapsed · ~${remaining}s remaining`);
    }
  }
  console.log(`\nDone — ${stats.ok} ok, ${stats.fail} fail, ${skipped} skipped (total ${stats.ok + skipped}/${scenes.length} on disk)`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
