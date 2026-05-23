#!/usr/bin/env node
/**
 * regen-image.mjs — regenere une image precise avec un seed offset different.
 *
 * Usage : node scripts/regen-image.mjs <sceneIndex> [seedBump]
 *   sceneIndex : index de la scene (0-based) dans script-trimmed.json
 *   seedBump   : offset additionnel ajoute au seed (defaut 10000, change ce
 *                nombre pour explorer d'autres compositions)
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadStyleKit, generateSceneImageWithRetry } from "./lib-wan-image.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Support JOB_DIR et STYLE_KIT env vars pour cibler le bon projet sans hardcoder.
const JOB_DIR = process.env.JOB_DIR
  ? (path.isAbsolute(process.env.JOB_DIR) ? process.env.JOB_DIR : path.join(ROOT, "public/generated", process.env.JOB_DIR))
  : path.join(ROOT, "public/generated/job_caesar_full");
const STYLE_KIT = process.env.STYLE_KIT
  ? (path.isAbsolute(process.env.STYLE_KIT) ? process.env.STYLE_KIT : path.join(ROOT, process.env.STYLE_KIT))
  : path.join(ROOT, "style-kit.json");
const CONFIG_PATH = path.join(ROOT, "config/settings.json");

const sceneIdx = parseInt(process.argv[2] ?? "0", 10);
const seedBump = parseInt(process.argv[3] ?? "10000", 10);
// Optionnel : override complet de sceneDescription via --desc="..."
const descArg = process.argv.find((a) => a.startsWith("--desc="));
const descOverride = descArg ? descArg.slice("--desc=".length) : null;

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const styleKit = loadStyleKit(STYLE_KIT);
const trimmedPath = path.join(JOB_DIR, "script-trimmed.json");
const fullPath = path.join(JOB_DIR, "script.json");
const scriptFile = existsSync(trimmedPath) ? trimmedPath : fullPath;
const script = JSON.parse(readFileSync(scriptFile, "utf-8"));
const scene = script.scenes[sceneIdx];
if (!scene) { console.error(`Scene ${sceneIdx} introuvable`); process.exit(1); }

const imgPath = path.join(JOB_DIR, "images", `scene_${String(sceneIdx).padStart(3, "0")}_c0.png`);
const seedOffset = sceneIdx * 1000 + seedBump;

console.log(`Regen scene ${sceneIdx} avec seedOffset=${seedOffset} (seed final = ${styleKit.project_seed + seedOffset})`);
console.log(`  narration : ${scene.narration}`);
console.log(`  char      : ${scene.hasMainCharacter}`);

// Priorite 1 : override CLI via --desc
// Priorite 2 : scene.generation.imagePrompt (schema v2 pre-build par Claude)
// Priorite 3 : scene.sceneDescription + framing (legacy)
let finalDesc;
if (descOverride) {
  finalDesc = descOverride;
} else if (scene.generation?.imagePrompt) {
  finalDesc = scene.generation.imagePrompt;
  if (scene.character?.present && scene.character.placement) {
    finalDesc += `. Caesar placement: ${scene.character.placement}`;
  }
} else {
  const FRAMING = scene.hasMainCharacter
    ? "wide establishing shot, full environment dominating the frame, character small in the lower right"
    : "wide establishing shot, full environment visible, symmetrical composition";
  finalDesc = `${scene.sceneDescription}, ${FRAMING}`;
}
console.log(`  desc      : ${finalDesc.slice(0, 160)}${finalDesc.length > 160 ? "..." : ""}`);

const r = await generateSceneImageWithRetry({
  config,
  sceneDescription: finalDesc,
  styleKit,
  outputPath: imgPath,
  sceneLabel: `scene${sceneIdx}_regen`,
  hasMainCharacter: scene.hasMainCharacter,
  expression: scene.expression || "",
  seedOffset,
});

console.log(`OK → ${r.imagePath}`);
