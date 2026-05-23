#!/usr/bin/env node
// Generate concat-flow-<slug>.json configs for the Dentist/Drink/Time/Talking
// projects from each project's script.json. Each scene's narration becomes the
// triggerText used by concat-flow.mjs for whisper alignment.

import { readFileSync, writeFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const PROJECTS = [
  { slug: "Dentist",  outName: "dentist.aligned.mp4" },
  { slug: "Drink",    outName: "drink.aligned.mp4" },
  { slug: "Time",     outName: "time.aligned.mp4" },
  { slug: "Talking",  outName: "talking.aligned.mp4" },
];

for (const p of PROJECTS) {
  const scriptPath = path.join(ROOT, "public/generated", p.slug, "script.json");
  const script = JSON.parse(readFileSync(scriptPath, "utf-8"));
  const scenes = script.scenes;

  const perImage = scenes.map((sc) => ({
    image: `scene_${String(sc.index).padStart(3, "0")}.png`,
    triggerText: (sc.narration || "").trim(),
  }));
  const list = perImage.map((i) => i.image);

  const cfg = {
    project: {
      name: p.slug,
      outputPath: `public/generated/${p.slug}/${p.outName}`,
    },
    images: {
      dir: `public/generated/${p.slug}/images`,
      count: list.length,
      order: "scene_index",
      list,
    },
    timing: {
      mode: "whisper_trigger_text",
      matchMode: "fuzzy_text",
      fallbackMode: "interpolate",
      cutRule: "start_at_trigger_end_at_next_trigger",
      minImageDurationSec: 0.4,
      maxImageDurationSec: 6,
      perImage,
    },
    video: { width: 1920, height: 1080, fps: 30 },
    encoder: { codec: "libx264", preset: "medium", crf: 20 },
  };

  const out = path.join(ROOT, `concat-flow-${p.slug.toLowerCase()}.json`);
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  console.log(`✓ ${out}  (${list.length} scenes)`);
}
