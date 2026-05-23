#!/usr/bin/env node
// parse-galveston-veo3.mjs — parse Galveston_1900_Veo3_Prompts.txt
// (146 scènes, 17 parts) → galveston_1900_veo3_prompts.json
//
// Sortie pour pipeline text-to-video (GenAIPro /v2/veo/text-to-video) :
//   { project, scenes: [{ id, scene_tag, part, section, title, vo, video_prompt, audio, duration_s }] }
//
// video_prompt : paragraphe visuel brut + ligne Atmosphere (le prompt Veo3 décrit
// déjà le mouvement caméra + action in-frame, on ne split pas).

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = process.argv[2] || "/Users/stephanezayat/Downloads/Galveston_1900_Veo3_Prompts.txt";
const OUT = process.argv[3] || path.join(ROOT, "galveston_1900_veo3_prompts.json");

function slug(s) {
  return s.toLowerCase()
    .replace(/[—–]/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

const text = readFileSync(SRC, "utf-8");
const lines = text.split(/\r?\n/);

const scenes = [];
let currentPartNum = 0;
let currentPartTitle = "";

let i = 0;
while (i < lines.length) {
  const line = lines[i];
  const partMatch = line.match(/^PART (\d+)\s*[—–-]\s*(.+?)\s*\(.*?\)\s*$/);
  if (partMatch) {
    currentPartNum = parseInt(partMatch[1], 10);
    currentPartTitle = partMatch[2].trim();
    i++;
    continue;
  }
  const sceneMatch = line.match(/^SCENE\s+(\d+[A-Z])\s*[—–-]\s*(.+?)\s*$/);
  if (!sceneMatch) { i++; continue; }
  const sceneTag = sceneMatch[1];
  const title = sceneMatch[2].trim();

  // VO is on the next non-blank/separator line, format: VO: "..."
  let vo = "";
  let j = i + 1;
  while (j < lines.length && j < i + 5) {
    const m = lines[j].match(/^VO:\s*"(.+?)"\s*$/);
    if (m) { vo = m[1].trim(); break; }
    j++;
  }
  // Skip until the closing separator line
  let k = (j > i ? j : i) + 1;
  while (k < lines.length && !lines[k].startsWith("--------")) k++;
  // Body starts after that separator
  let bodyStart = k + 1;
  // Body ends at the next separator (------) or next SCENE/PART or end
  let bodyEnd = bodyStart;
  while (bodyEnd < lines.length) {
    const l = lines[bodyEnd];
    if (l.startsWith("------------------------------------------------------------")
        || l.startsWith("================================================================================")
        || l.match(/^SCENE\s+\d+[A-Z]\s*[—–-]/)
        || l.match(/^PART\s+\d+\s*[—–-]/)) break;
    bodyEnd++;
  }
  const bodyLines = lines.slice(bodyStart, bodyEnd);

  // Extract sections from body : main paragraph, Atmosphere, Audio, Duration
  const body = bodyLines.join("\n").trim();
  const atmosphereMatch = body.match(/Atmosphere:\s*([\s\S]+?)(?=\nAudio:|\nDuration:|$)/);
  const audioMatch = body.match(/Audio:\s*([\s\S]+?)(?=\nDuration:|$)/);
  const durationMatch = body.match(/Duration:\s*(\d+)\s*seconds?/i);

  // Visual paragraph = everything before "Atmosphere:" (or full body if missing)
  const atmIdx = body.indexOf("Atmosphere:");
  const visual = (atmIdx >= 0 ? body.slice(0, atmIdx) : body).trim();
  const atmosphere = atmosphereMatch ? atmosphereMatch[1].trim().replace(/\n/g, " ") : "";
  const audio = audioMatch ? audioMatch[1].trim().replace(/\n/g, " ") : "";
  const duration = durationMatch ? parseInt(durationMatch[1], 10) : 4;

  // --- VIDEO PROMPT (T2V) ---
  // On garde le paragraphe Veo3 brut + Atmosphere + un suffixe sécurité.
  // Pas de split : Veo3 décrit déjà caméra + motion + atmosphère ensemble.
  const videoPromptParts = [
    visual,
    atmosphere ? `Atmosphere: ${atmosphere}` : null,
    `Duration: ${duration} seconds. Photorealistic period-accurate 1900, anamorphic lens, cinematic 16:9. No on-screen text, no captions, no watermark, no logo.`,
  ].filter(Boolean);
  const video_prompt = videoPromptParts.join(" ").replace(/\s+/g, " ").trim();

  scenes.push({
    id: scenes.length + 1,
    scene_tag: sceneTag,
    part: currentPartNum,
    part_title: currentPartTitle,
    section: `p${String(currentPartNum).padStart(2, "0")}_${sceneTag.toLowerCase()}_${slug(title)}`,
    title,
    vo,
    duration_s: duration,
    video_prompt,
    audio,
  });

  i = bodyEnd;
}

const out = {
  project: "galveston_1900_veo3",
  source: path.basename(SRC),
  scenes,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`OK ${scenes.length} scènes parsées -> ${OUT}`);
console.log(`Parts : ${[...new Set(scenes.map((s) => `${s.part}: ${s.part_title}`))].join("\n        ")}`);
console.log(`Premier : #${scenes[0].id} ${scenes[0].scene_tag} "${scenes[0].title}"`);
console.log(`Dernier : #${scenes[scenes.length - 1].id} ${scenes[scenes.length - 1].scene_tag} "${scenes[scenes.length - 1].title}"`);
