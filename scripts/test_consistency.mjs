#!/usr/bin/env node
/**
 * test_consistency.mjs — genere 3 scenes differentes avec le MEME style kit
 * pour valider visuellement la coherence perso/style.
 *
 * Chaque scene_description decrit UNIQUEMENT le decor/action — character_block
 * et style_block sont injectes par generateSceneImage.
 *
 * Sortie : /tmp/consistency_test/scene_0.png, scene_1.png, scene_2.png
 *          + /tmp/consistency_test/images_results.json
 *
 * Usage : node scripts/test_consistency.mjs
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadStyleKit, generateSceneImageCached } from "./lib-wan-image.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const STYLE_KIT_PATH = path.join(ROOT, "style-kit.json");
const CONFIG_PATH = path.join(ROOT, "config/settings.json");
const OUT_DIR = "/tmp/consistency_test";
const CACHE_PATH = path.join(OUT_DIR, "images_results.json");

const TEST_SCENES = [
  "He stands inside a bustling medieval castle kitchen. A large hearth fire on the left casts a warm orange glow. Flat-colored hanging pots, bundles of herbs, wooden table with cartoon bread and a roast chicken. Blurry background characters with simpler white heads and basic tunics.",
  "He walks through a muddy medieval village street at dusk. Timber-framed houses with thatched roofs flank both sides. A few peasants in brown robes carry baskets. Soft purple-orange sunset sky, a distant castle silhouette on a hill.",
  "He sits alone at a heavy wooden desk inside a stone tower library, surrounded by open leather-bound books and a flickering candle. Tall narrow window on the right showing a stormy night sky. Warm candlelight vs cool moonlight contrast.",
];

async function main() {
  console.log("=== TEST CONSISTENCY — wan-2.7/image-edit + style-kit ===\n");

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : {};
  const styleKit = loadStyleKit(STYLE_KIT_PATH);

  console.log(`Style kit : ${STYLE_KIT_PATH}`);
  console.log(`  seed=${styleKit.project_seed}  hash=${styleKit._hash.slice(0, 8)}  refs=${styleKit.style_refs.length}`);
  console.log(`Sortie    : ${OUT_DIR}\n`);

  for (let i = 0; i < TEST_SCENES.length; i++) {
    const outputPath = path.join(OUT_DIR, `scene_${i}.png`);
    const t0 = Date.now();
    try {
      const result = await generateSceneImageCached({
        config,
        sceneKey: `test_${i}`,
        sceneDescription: TEST_SCENES[i],
        styleKit,
        outputPath,
        cachePath: CACHE_PATH,
      });
      const tag = result.fromCache ? "CACHE" : `OK ${((Date.now() - t0) / 1000).toFixed(1)}s`;
      console.log(`  [${tag}] scene_${i} → ${outputPath}`);
    } catch (e) {
      console.error(`  [FAIL] scene_${i} : ${e.message}`);
    }
  }

  console.log("\nValidation visuelle manuelle : ouvrir les 3 PNGs et verifier");
  console.log("que le perso (tete blanche sphere, tunique, cape sienna) et");
  console.log("le style 2D cel-shading sont identiques scene apres scene.");
}

main().catch((err) => {
  console.error("ERREUR FATALE:", err);
  process.exit(1);
});
