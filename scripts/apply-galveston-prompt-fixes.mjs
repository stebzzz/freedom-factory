#!/usr/bin/env node
// One-shot: parse galveston_failed_generations_all_16_fixed.txt and patch
// galveston_1900_veo3_prompts.json (video_prompt + vo) for the 16 listed IDs.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TXT = process.env.FIX_TXT || path.join(process.env.HOME, "Downloads/galveston_failed_generations_all_16_fixed.txt");
const JSON_PATH = path.join(ROOT, "galveston_1900_veo3_prompts.json");

const txt = readFileSync(TXT, "utf-8");
const j = JSON.parse(readFileSync(JSON_PATH, "utf-8"));

// Split by lines starting with "# <number> — "
const blocks = [];
const lines = txt.split(/\r?\n/);
let cur = null;
for (const line of lines) {
  const m = line.match(/^#\s+(\d+)\s+—/);
  if (m) {
    if (cur) blocks.push(cur);
    cur = { id: parseInt(m[1], 10), header: line, body: [] };
  } else if (cur) {
    cur.body.push(line);
  }
}
if (cur) blocks.push(cur);

const patched = [];
const missing = [];
for (const b of blocks) {
  // body: VO line, blank line, then prompt paragraph(s) until blank line/EOF
  const idx = b.body.findIndex((l) => /^VO:\s*"/.test(l));
  if (idx < 0) { missing.push(b.id); continue; }
  const voMatch = b.body[idx].match(/^VO:\s*"(.+)"\s*$/);
  const vo = voMatch ? voMatch[1] : null;
  // Skip empty lines, then collect prompt until next blank line
  let i = idx + 1;
  while (i < b.body.length && b.body[i].trim() === "") i++;
  const promptLines = [];
  while (i < b.body.length && b.body[i].trim() !== "") {
    promptLines.push(b.body[i]);
    i++;
  }
  const prompt = promptLines.join(" ").trim();
  if (!prompt) { missing.push(b.id); continue; }
  const scene = j.scenes.find((s) => s.id === b.id);
  if (!scene) { missing.push(b.id); continue; }
  scene.video_prompt = prompt;
  if (vo) scene.vo = vo;
  patched.push(b.id);
}

const backup = JSON_PATH.replace(/\.json$/, `.backup-${Date.now()}.json`);
copyFileSync(JSON_PATH, backup);
writeFileSync(JSON_PATH, JSON.stringify(j, null, 2));
console.log(`Patched ${patched.length}/${blocks.length} scenes:`, patched.sort((a,b)=>a-b).join(","));
if (missing.length) console.log(`MISSING (skipped):`, missing);
console.log(`Backup -> ${path.relative(ROOT, backup)}`);
