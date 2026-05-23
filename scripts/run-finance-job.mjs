#!/usr/bin/env node
/**
 * run-finance-job.mjs — pipeline video explicative finance / whiteboard style (FR)
 *
 *   - Narration : script txt (1er arg CLI)
 *   - Images    : WaveSpeed wan-2.7/image-edit + style-kit-finance.json
 *                 → whiteboard explainer, avatar expert + silhouettes patients.
 *   - I2V       : bytedance/seedance-v1-pro-fast UNIQUEMENT sur l'accroche (~ANIMATED_INTRO_SECONDS
 *                 secondes au debut, decoupees en sous-clips 4-7s). Le reste de la video
 *                 = sequence d'images statiques (max STATIC_IMAGE_MAX_DURATION s/image)
 *                 enchainees par crossfade ffmpeg, PAS d'I2V.
 *   - Voiceover : ElevenLabs voix narrateur (config/settings.json)
 *   - Montage   : FFmpeg xfade entre tous les segments (clips video + images statiques),
 *                 audio scene-aligne
 *
 * Usage : node scripts/run-finance-job.mjs [path/to/script.txt]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from "fs";
import { execSync } from "child_process";
import { createHash } from "crypto";
import https from "https";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

import { jsonrepair } from "jsonrepair";

import {
  loadStyleKit,
  generateSceneImageCached,
  generateI2VClipWithRetry,
} from "./lib-wan-image.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ===================== CONFIG =====================
// Permet de lancer des tests dans un dossier different sans casser l'existant:
//   JOB_DIR=job_finance_v1 node scripts/run-finance-job.mjs ...
const JOB_DIR = process.env.JOB_DIR
  ? path.isAbsolute(process.env.JOB_DIR)
    ? process.env.JOB_DIR
    : path.join(ROOT, "public/generated", process.env.JOB_DIR)
  : path.join(ROOT, "public/generated/job_finance_full");
// Override style-kit via env: STYLE_KIT=style-kit-finance.json ou chemin absolu
const STYLE_KIT_PATH = process.env.STYLE_KIT
  ? (path.isAbsolute(process.env.STYLE_KIT) ? process.env.STYLE_KIT : path.join(ROOT, process.env.STYLE_KIT))
  : path.join(ROOT, "style-kit-finance.json");
const CONFIG_PATH = path.join(ROOT, "config/settings.json");
const DEFAULT_SCRIPT_PATH = path.join(ROOT, "script-videofr.txt");
// Ce run : avec voix off ElevenLabs, sans sous-titres brules
const SKIP_VOICE = process.argv.includes("--skip-voice");
const SKIP_SUBTITLES = true;   // pas de sous-titres dans ce type de video

const SCENE_PARSE_BATCH = 5;      // Claude — parse segments en parallele
const IMAGE_BATCH_SIZE = 30;      // WaveSpeed Silver : 60 concurrent, on garde marge
const CLIP_BATCH_SIZE = 30;       // idem video : 60 concurrent, marge de securite
const WPM = 120;
const TRANSITION_DUR = 0.5;   // crossfade 0.5s entre chaque segment
const FPS = 24;
// Accroche animee (debut de video) : tant que sum(audioDur) <= ce seuil, les scenes
// sont decoupees en sous-clips et passees a I2V seedance. Au-dela, on bascule en
// images statiques avec crossfade. Override via env: ANIMATED_INTRO_SECONDS=90.
const ANIMATED_INTRO_SECONDS = process.env.ANIMATED_INTRO_SECONDS
  ? parseFloat(process.env.ANIMATED_INTRO_SECONDS)
  : 60;
// Duree max d'affichage d'une image statique a l'ecran. Une scene de N secondes
// est decoupee en ceil(N / STATIC_IMAGE_MAX_DURATION) chunks d'images differentes
// avec crossfade entre chacune. Plus c'est petit, plus on paie d'images wan-2.7.
const STATIC_IMAGE_MAX_DURATION = process.env.STATIC_IMAGE_MAX_DURATION
  ? parseFloat(process.env.STATIC_IMAGE_MAX_DURATION)
  : 3;
// Cap implicite de seedance v1 pro fast : ~5s par clip peu importe la durée demandée
// dans le body. On l'utilise pour decider quand splitter une scene en sous-clips
// (sinon une scene de 7s devient 1 clip seedance tronque a 5s → 2s de drift audio).
const SEEDANCE_MAX_CLIP_DUR = 5;
// Duree max du test (cap strict, pas de scene au-dela). Override via --pilot N.
//   --pilot 30  → 30s
//   --pilot 0   → pas de cap (full script)
//   (defaut)    → 0 (full script)
const PILOT_ARG = process.argv.find((a, i, arr) => (a === "--pilot" || a === "-p") && arr[i + 1]);
const PILOT_IDX = PILOT_ARG ? process.argv.indexOf(PILOT_ARG) + 1 : -1;
const MAX_DURATION_S = PILOT_IDX > 0 ? parseInt(process.argv[PILOT_IDX], 10) || 0 : 0;

const LIMIT_ARG = process.argv.find((a, i, arr) => (a === "--limit" || a === "-l") && arr[i + 1]);
const LIMIT_IDX = LIMIT_ARG ? process.argv.indexOf(LIMIT_ARG) + 1 : -1;
const MAX_SCENES = LIMIT_IDX > 0 ? parseInt(process.argv[LIMIT_IDX], 10) || 0 : 0;
const CLIP_DUR_MIN = 3;
const CLIP_DUR_MAX = 7;
const I2V_RESOLUTION = "720p";   // 720p sans son
// Montage = VIDEO ~15min :
//   Accroche (debut) : ANIMATED_INTRO_SECONDS de video animee via I2V, scenes decoupees
//     en sous-clips 4-7s, 1 image par sous-clip, mouvement camera + sujets.
//   Apres l'accroche : suite d'images statiques affichees max STATIC_IMAGE_MAX_DURATION s
//     chacune (chaque scene split en N chunks d'images), crossfade entre toutes.
const FRAMING_VARIANTS_CHAR = [
  "medium shot, expert standing on the right, pointing at a chart or board on the left",
  "wide shot, expert small on the left, large infographic or data display filling the right",
  "medium close-up, expert centered, shoulders up, professional look, explaining directly",
  "wide shot, expert standing in front of a group of faceless silhouettes, presenting",
  "over-the-shoulder from behind the audience, expert visible in the distance with a board",
  "medium shot, expert holding a prop (coin, contract, umbrella) to illustrate a point",
];

const FRAMING_VARIANTS_ENV = [
  "wide shot, abstract background with floating icons (coins, charts, arrows)",
  "extreme close-up on a key prop (contract, red cross, falling coin)",
  "wide symbolic shot, a giant broken piggy bank on a white background",
  "medium shot, a bar chart with a red downward arrow, clean background",
  "wide shot, a row of faceless silhouettes with red crosses on their chests",
  "close-up, a hand holding a cracked shield or umbrella, symbolic",
];

// Mouvement camera pour la 1ere scene animee uniquement.
const CAMERA_VARIANTS = [
  "slow camera push-in, gentle zoom toward center",
  "slow camera pan from left to right across the scene",
  "gentle pull-back reveal, camera slowly drifts backward",
  "subtle camera tilt upward, soft parallax",
  "slight handheld drift, organic atmospheric motion",
  "slow orbit around the subject, smooth rotation",
];

/**
 * Decoupe une scene STATIC de duree D en chunks d'images, chacun affiche au plus
 * STATIC_IMAGE_MAX_DURATION secondes. La somme des chunks = D.
 */
function splitStaticSceneIntoImageChunks(D) {
  const safeD = Math.max(0.5, D);
  const nChunks = Math.max(1, Math.ceil(safeD / STATIC_IMAGE_MAX_DURATION));
  const base = safeD / nChunks;
  const out = [];
  for (let i = 0; i < nChunks; i++) out.push(base);
  return out;
}

/**
 * Decoupe une scene de duree D en clips de [CLIP_DUR_MIN, CLIP_DUR_MAX] secondes
 * dont la somme = D (pour rester aligne sur la narration).
 */
function splitSceneIntoClipDurations(D) {
  const safeD = Math.max(CLIP_DUR_MIN, Math.round(D));
  // On utilise SEEDANCE_MAX_CLIP_DUR (= cap implicite seedance ~5s) pour choisir le
  // nombre de sous-clips, sinon une scene de 6-7s tient en 1 clip "demande" mais le
  // fichier mp4 retourne ne fait que 5s → drift cumule sur la timeline xfade.
  const nClips = Math.max(1, Math.ceil(safeD / SEEDANCE_MAX_CLIP_DUR));
  const base = Math.floor(safeD / nClips);
  const remainder = safeD - base * nClips;
  const out = [];
  for (let i = 0; i < nClips; i++) {
    let d = base + (i < remainder ? 1 : 0);
    if (d < CLIP_DUR_MIN) d = CLIP_DUR_MIN;
    if (d > SEEDANCE_MAX_CLIP_DUR) d = SEEDANCE_MAX_CLIP_DUR;
    out.push(d);
  }
  return out;
}

// ===================== UTILS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function askConfirm(message) {
  const autoYes = process.argv.includes("--yes") || process.argv.includes("-y");
  if (autoYes) { console.log(`${message} [auto-yes via --yes]`); return Promise.resolve(true); }
  if (!process.stdin.isTTY) {
    // Non-TTY (bash background) : default SAFE = abort. L'appelant doit passer
    // --yes explicitement pour continuer. Evite de cramer du Kling par accident.
    console.log(`${message} [non-TTY sans --yes → NO]`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (ans) => {
      rl.close();
      resolve(/^(y|yes|o|oui)$/i.test(ans.trim()));
    });
  });
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function httpsPost(hostname, urlPath, headers, body, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    // Pas de keep-alive : fraiche connexion par appel, evite les sockets stale qui causent
    // des "socket hang up" sur les reponses longues d'Opus 4.7 (~60-120s).
    const req = https.request(
      { hostname, path: urlPath, method: "POST", headers: { ...headers, connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    // Socket idle timeout : tolere jusqu'a 600s sans data (Opus thinking + long output).
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`HTTP POST timeout ${timeoutMs}ms`)); });
    if (body) req.write(body);
    req.end();
  });
}

async function callClaude(apiKey, prompt, maxTokens = 4096) {
  // Streaming obligatoire pour Opus 4.7 sur longues reponses : sans stream, l'edge
  // d'Anthropic coupe la connexion TCP apres ~60s → "socket hang up" / ECONNRESET.
  // Avec stream, les SSE events maintiennent le flux actif → pas de timeout reseau.
  const body = JSON.stringify({
    model: "claude-opus-4-7",
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-length": Buffer.byteLength(body).toString(),
        connection: "close",
      },
    }, (res) => {
      let buf = "";
      let textOut = "";
      let errBuf = "";
      if (res.statusCode && res.statusCode >= 400) {
        res.on("data", (c) => errBuf += c.toString());
        res.on("end", () => reject(new Error(`Claude ${res.statusCode}: ${errBuf.slice(0, 300)}`)));
        return;
      }
      res.on("data", (c) => {
        buf += c.toString();
        // SSE = lignes "event: X\ndata: {...}\n\n"
        const events = buf.split("\n\n");
        buf = events.pop() || ""; // garde le dernier event incomplet
        for (const ev of events) {
          const dataLine = ev.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            // content_block_delta contient le vrai texte streame
            if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
              textOut += obj.delta.text;
            } else if (obj.type === "error") {
              reject(new Error(`Claude stream error: ${JSON.stringify(obj.error || obj).slice(0, 200)}`));
            }
          } catch { /* payload partiel ou event pas JSON, skip */ }
        }
      });
      res.on("end", () => resolve(textOut.trim()));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(600000, () => { req.destroy(new Error("Stream timeout 600s")); });
    req.write(body);
    req.end();
  });
}

async function callClaudeRetry(apiKey, prompt, label, maxTokens = 4096) {
  // Backoff long : 15s, 30s. Les "socket hang up" sont souvent transitoires cote serveur.
  const backoffs = [15000, 30000];
  for (let a = 1; a <= 3; a++) {
    try { return await callClaude(apiKey, prompt, maxTokens); }
    catch (e) {
      console.warn(`  [${label}] Tentative ${a}/3: ${e.message}`);
      if (a < 3) await sleep(backoffs[a - 1]); else throw e;
    }
  }
}

// ===================== STEP 1: PARSE SCENES =====================
// Approche : split le script en phrases (sur .!?). 1 phrase = 1 scene.
// Claude annote chaque phrase avec {sceneDescription, hasMainCharacter, expression}.
// Duree = estimation a partir du word count (WPM).

/**
 * Split le texte en segments clip, chaque segment = 1 clip video.
 *
 *   1. Split sur [.!?] → phrases "periode"
 *   2. Si une phrase dure > CLIP_DUR_MAX, on la split sur les virgules et on
 *      remplit chaque sous-segment jusqu'a CLIP_DUR_MAX max.
 *   3. Les segments tres courts adjacents (< CLIP_DUR_MIN) sont fusionnes tant
 *      que le resultat reste <= CLIP_DUR_MAX.
 */
function splitIntoClipSegments(fullText) {
  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
  const durOf = (s) => (wordCount(s) / WPM) * 60;

  // 1. Periode
  const sentences = fullText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  // 2. Split virgule pour les phrases longues
  const segments = [];
  for (const sent of sentences) {
    if (durOf(sent) <= CLIP_DUR_MAX) {
      segments.push(sent);
      continue;
    }
    const parts = sent.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
    let buf = "";
    for (const p of parts) {
      const candidate = buf ? `${buf}, ${p}` : p;
      if (durOf(candidate) > CLIP_DUR_MAX && buf) {
        segments.push(buf);
        buf = p;
      } else {
        buf = candidate;
      }
    }
    if (buf) segments.push(buf);
  }

  // 3. Fusion segments tres courts adjacents
  const merged = [];
  for (const seg of segments) {
    if (merged.length === 0) { merged.push(seg); continue; }
    const last = merged[merged.length - 1];
    const combined = `${last} ${seg}`;
    if (durOf(last) < CLIP_DUR_MIN && durOf(combined) <= CLIP_DUR_MAX) {
      merged[merged.length - 1] = combined;
    } else {
      merged.push(seg);
    }
  }

  return merged;
}

/**
 * Annote un batch de segments via Claude. Retourne un array d'annotations (meme ordre).
 * fullScript = texte complet du script, donne en contexte a Claude pour continuite narrative.
 * Schema v2 : nested (environment / visual / character / motion / generation / timing).
 */
async function annotateSentenceBatch(apiKey, sentences, startIdx, totalSentences, fullScript = "") {
  const numbered = sentences.map((s, i) => `${startIdx + i + 1}. ${s}`).join("\n\n");

  const prompt = `Tu es directeur artistique / storyboardeur pour une video explicative YouTube (whiteboard animation style / corporate cartoon).
Le sujet est probablement lie a la finance, l'economie, ou la sante (ton serieux mais accessible).
La narration est directe, explique des concepts, et met en scene un protagoniste "expert" (le docteur / conseiller) face a un public "victime" ou de simples citoyens.

ART DIRECTION (IMMUABLE — identique sur TOUTES les scenes):
- Style: 2D vector cartoon, whiteboard animation style, corporate explainer. PAS photorealiste, PAS 3D, PAS anime.
- Palette: Couleurs claires et corporate. Fond generalement blanc ou tres simple.
- Outlines: bold thick outlines sur les personnages et les gros elements.
- Visages: TRES SIMPLIFIES. Le protagoniste a des yeux en points noirs et une ligne pour la bouche. Les autres personnages (patients/citoyens) sont presque sans visage, de simples silhouettes vectorielles (parfois avec une croix rouge sur le torse).
- Protagoniste: identite LOCKED via style-kit (expert / docteur).

AVANT D'ECRIRE LE JSON, raisonne sur la progression explicative:
- Identifie le concept a illustrer dans le segment.
- Varie shot types: MEDIUM sur l'expert au tableau, WIDE avec le public, CLOSE-UP sur un graphique ou un contrat, METAPHORES VISUELLES (une grosse piece de monnaie qui tombe, un parapluie qui se dechire).
- Decide quand l'expert est dans le cadre vs absent (focus graphique/metaphore).
- Continuite: memes locationId reutilises = meme decor (ex: office_whiteboard, abstract_money_background).

${fullScript ? `CONTEXTE NARRATIF COMPLET:

"""
${fullScript}
"""

` : ""}Pour CHAQUE segment ci-dessous, produis UN objet JSON avec la STRUCTURE NESTED suivante :

{
  "environment": {
    "locationId": "string snake_case EN ANGLAIS (ex: white_office_board, abstract_falling_coins, hospital_waiting_room)",
    "settingType": "string court (ex: 'clean white office with a chart board', 'abstract void with floating money')",
    "timeOfDay": "timeless",
    "weather": "n/a",
    "lighting": "flat clean corporate lighting, no shadows"
  },
  "visual": {
    "shotType": "wide / medium / close-up / extreme close-up insert / abstract symbolic",
    "focus": "ce sur quoi le plan attire l'oeil (ex: 'the red downward line on the chart', 'the doctor pointing at the audience')",
    "composition": "arrangement spatial",
    "sceneDescription": "DENSE 50-100 mots: decor + persos (expert, faceless patients with red crosses) + action + props. JAMAIS 'no characters present' (sauf prop-closeup). PAS de mention du style cartoon (locked globalement)."
  },
  "character": {
    "present": boolean,
    "ageInScene": 35,
    "expression": "court (ex: 'professional smile', 'serious concern')",
    "placement": "OU et COMMENT l'expert est dans le cadre. Ex: 'standing right, pointing left at a chart'",
    "pose": "posture corporelle (ex: 'arms crossed', 'pointing finger')"
  },
  "motion": {
    "environment": ["array de 1-3 mouvements: 'red chart line goes down', 'coins fall from the sky'"],
    "character": ["array de micro-mouvements expert"],
    "camera": {
      "type": "static / subtle drift / slow push-in",
      "direction": "",
      "speed": "none-static / very slow"
    }
  },
  "generation": {
    "imagePrompt": "STRING dense directement injectable dans l'API image en ANGLAIS: reprends visual.sceneDescription + environment.lighting + visual.composition + (si character.present) mentionne 'The expert / doctor'. Exemples : 'A clean white office, the expert standing next to a whiteboard showing a red downward arrow, pointing at it, three faceless silhouettes with red crosses on their chests sitting in front'. NE PAS ajouter le style (injecte separement).",
    "negativePrompt": "elements a bannir (ex: 'realistic faces, 3D, detailed backgrounds, messy lines')"
  }
}

Reponds UNIQUEMENT avec JSON strict, ARRAY "scenes" dans l'ordre des segments, meme nombre d'elements (${sentences.length}):
{ "scenes": [ { ...schema ci-dessus... }, ... ] }

SEGMENTS A ANNOTER (${sentences.length}) :
${numbered}`;

  // No fallback: en cas d'erreur on throw pour qu'on voie le vrai probleme.
  // 32K output : annotations yakuza riches (~3K tokens/scene avec irezumi/age/marqueurs)
  // peuvent saturer 16K en mid-batch et tronquer le JSON.
  const result = await callClaudeRetry(apiKey, prompt, `Segments ${startIdx + 1}-${startIdx + sentences.length}/${totalSentences}`, 32768);

  // JSON parse robuste :
  //  1. Try parse direct (sanitized)
  //  2. Strip markdown fences (```json ... ``` n'importe ou dans la reponse)
  //  3. Fallback: extract premier bloc JSON qui commence par {"scenes":
  //  4. Fallback: outer {...}
  //
  // Sanitize : Opus produit parfois du garbage qui casse JSON.parse :
  //   - Lignes orphelines `""` au milieu d'un objet (ex: `"weather":"x", \n "" \n },`)
  //   - Trailing commas avant } ou ]
  // On retire ces patterns avant chaque tentative.
  const sanitize = (s) => s
    .replace(/,\s*""\s*(?=[,}\]])/g, "")  // ", ""," ou ", ""}" → retire
    .replace(/(?<=[{,])\s*""\s*(?=[,}\]])/g, "")  // "{ ""," ou "{ ""}" → retire
    .replace(/,(\s*[}\]])/g, "$1");  // trailing commas
  // tryParse : JSON.parse direct, sinon jsonrepair (corrige virgules manquantes,
  // strings non terminees, etc — Opus produit ces erreurs sur de longues sorties).
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(jsonrepair(s)); } catch { return null; }
  };
  const extractJson = (raw) => {
    const r = sanitize(raw.trim());
    let p = tryParse(r); if (p) return p;
    // Cherche un bloc markdown code fence
    const fenceMatch = r.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      p = tryParse(sanitize(fenceMatch[1].trim())); if (p) return p;
    }
    // Cherche un objet JSON qui commence par {"scenes"
    const scenesMatch = r.match(/\{\s*"scenes"\s*:[\s\S]*$/);
    if (scenesMatch) {
      let depth = 0, end = -1;
      for (let i = 0; i < scenesMatch[0].length; i++) {
        const c = scenesMatch[0][i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        p = tryParse(sanitize(scenesMatch[0].slice(0, end))); if (p) return p;
      }
    }
    // Dernier recours: greedy
    const m = r.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return tryParse(sanitize(m[0]));
  };
  const parsedObj = extractJson(result);
  if (!parsedObj) {
    console.error(`  [debug] FULL raw response:\n${result}`);
    throw new Error(`No valid JSON in Claude response (${result.length} chars)`);
  }
  const parsed = parsedObj.scenes;
  if (!Array.isArray(parsed) || parsed.length !== sentences.length) {
    console.error(`  [debug] parsedObj keys: ${Object.keys(parsedObj).join(", ")}`);
    throw new Error(`Expected ${sentences.length} scenes in 'scenes' array, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
  }
  console.log(`  [annotate] ${parsed.length} scenes parsed`);
  return sentences.map((_, i) => ({ ...defaultAnnotation(), ...parsed[i] }));
}

function defaultAnnotation() {
  return {
    environment: {
      locationId: "white_office_board",
      settingType: "clean white office with a chart board",
      timeOfDay: "timeless",
      weather: "n/a",
      lighting: "flat clean corporate lighting, no shadows",
    },
    visual: {
      shotType: "medium",
      focus: "the expert pointing at the board",
      composition: "expert standing right, board taking up the center",
      sceneDescription: "a clean white office, the expert standing next to a whiteboard, pointing at a descending red chart line, three faceless silhouettes with red crosses on their chests sitting in front as patients",
    },
    character: {
      present: true,
      ageInScene: 35,
      expression: "professional concern",
      placement: "standing right",
      pose: "pointing left with one hand",
    },
    motion: {
      environment: ["red chart line blinks"],
      character: ["subtle hand gesture"],
      camera: { type: "static", direction: "", speed: "none-static" },
    },
    generation: {
      imagePrompt: "a clean white office, the expert/doctor standing next to a whiteboard showing a red downward chart line, pointing at it with one hand, three faceless silhouettes with red crosses on their chests sitting in front as patients, flat clean corporate lighting",
      negativePrompt: "realistic faces, photorealistic, 3D render, complex gradients, detailed shading, dark cinematic lighting",
    },
  };
}

/**
 * Transforme une phrase + annotation en objet scene complet.
 * Duree = word count / (WPM/60), min CLIP_DUR_MIN pour eviter les scenes sub-4s.
 */
function sentenceToScene(sentence, annotation, index) {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  const estimated = (words / WPM) * 60;
  const duration = Math.max(CLIP_DUR_MIN, Math.min(CLIP_DUR_MAX, Math.round(estimated)));
  // Deep merge avec defaultAnnotation pour que toutes les sous-sections existent meme si
  // Claude en oublie une. Flatten aussi les champs principaux au niveau racine pour que le
  // pipeline existant (hasMainCharacter, sceneDescription, locationId, characterPlacement,
  // cameraMotion) continue de marcher sans refacto.
  const def = defaultAnnotation();
  const env = { ...def.environment, ...(annotation.environment || {}) };
  const visual = { ...def.visual, ...(annotation.visual || {}) };
  const character = { ...def.character, ...(annotation.character || {}) };
  const motion = {
    environment: annotation.motion?.environment || def.motion.environment,
    character: annotation.motion?.character || def.motion.character,
    camera: { ...def.motion.camera, ...(annotation.motion?.camera || {}) },
  };
  const generation = { ...def.generation, ...(annotation.generation || {}) };

  // Build cameraMotion flat string pour back-compat avec la boucle Kling.
  const cameraMotionFlat = [
    motion.environment.join("; "),
    motion.character.length ? `character: ${motion.character.join(", ")}` : "",
    motion.camera.type && motion.camera.type !== "static"
      ? `camera: ${motion.camera.type}${motion.camera.direction ? " " + motion.camera.direction : ""} (${motion.camera.speed})`
      : "static camera",
  ].filter(Boolean).join(". ");

  return {
    // Nested (nouvelle structure)
    environment: env,
    visual,
    character,
    motion,
    generation,
    // Flat (back-compat avec le reste du pipeline)
    narration: sentence,
    sceneDescription: visual.sceneDescription,
    hasMainCharacter: character.present !== false,
    expression: character.expression || "",
    ageInScene: character.ageInScene || null,
    locationId: env.locationId,
    characterPlacement: character.placement || "",
    cameraMotion: cameraMotionFlat,
    durationSeconds: duration,
    narrationDurationSeconds: estimated,
    index,
  };
}

// ===================== STEP 2: VOICEOVER (reprise sleepy) =====================
function chunkText(text, maxChars = 4000) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += (current ? " " : "") + s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function generateVoiceoverChunk(apiKey, voiceId, text) {
  const body = JSON.stringify({
    text,
    model_id: "eleven_multilingual_v2"
  });

  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: true, timeout: 600000 });
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${voiceId}`,
      method: "POST",
      agent,
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
        "content-length": Buffer.byteLength(body).toString(),
        connection: "keep-alive",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) reject(new Error(`ElevenLabs ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        else resolve(buf);
      });
    });
    req.on("error", reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error("ElevenLabs timeout 600s")); });
    req.write(body);
    req.end();
  });
}

async function generateVoiceover(config, script, outputPath) {
  const apiKey = config.elevenlabsKey;
  if (!apiKey) { console.log("  [Voiceover] Pas de cle ElevenLabs — skip"); return null; }

  const voiceId = config.elevenlabsVoiceId || "yl2ZDV1MzN4HbQJbMihG";
  const chunks = chunkText(script);
  console.log(`  ${chunks.length} chunks`);

  const audioBuffers = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`  Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    let buf = null;
    for (let a = 1; a <= 3; a++) {
      try { buf = await generateVoiceoverChunk(apiKey, voiceId, chunks[i]); break; }
      catch (e) {
        console.warn(`  Chunk ${i + 1} tentative ${a}/3: ${e.message}`);
        if (a < 3) await sleep(a * 3000); else throw e;
      }
    }
    audioBuffers.push(buf);
    if (i < chunks.length - 1) await sleep(1000);
  }

  if (audioBuffers.length === 1) {
    writeFileSync(outputPath, audioBuffers[0]);
  } else {
    const tempDir = path.dirname(outputPath);
    const concatList = [];
    for (let i = 0; i < audioBuffers.length; i++) {
      const tempFile = path.resolve(tempDir, `vo_chunk_${i}.mp3`);
      writeFileSync(tempFile, audioBuffers[i]);
      concatList.push(`file '${tempFile}'`);
    }
    const concatFile = path.join(tempDir, "vo_concat.txt");
    writeFileSync(concatFile, concatList.join("\n"));
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`, { stdio: "pipe" });
    for (let i = 0; i < audioBuffers.length; i++) {
      try { unlinkSync(path.resolve(tempDir, `vo_chunk_${i}.mp3`)); } catch { }
    }
    try { unlinkSync(concatFile); } catch { }
  }

  const dur = Math.round(script.split(/\s+/).length / 2.5);
  console.log(`  Audio: ${outputPath} (~${dur}s)`);
  return { audioPath: outputPath, durationSeconds: dur };
}

function ffprobeDuration(p) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf-8" });
  return parseFloat(out.trim());
}

/**
 * Voiceover PAR SCENE : 1 appel ElevenLabs par scene → 1 fichier MP3 par scene.
 * La duree reelle de chaque audio est mesuree avec ffprobe → sync audio/video
 * scene-level impeccable (plus besoin de scaler globalement apres coup).
 *
 * Renvoie : Array<{ sceneIndex, audioPath, durationSeconds }>
 */
async function generateVoiceoverPerScene(config, scenes, voiceDir) {
  const apiKey = config.elevenlabsKey;
  if (!apiKey) { console.log("  [Voiceover] Pas de cle ElevenLabs — skip"); return null; }

  const voiceId = config.elevenlabsVoiceId || "yl2ZDV1MzN4HbQJbMihG";
  if (!existsSync(voiceDir)) mkdirSync(voiceDir, { recursive: true });

  const results = [];
  for (const scene of scenes) {
    const scenePath = path.join(voiceDir, `scene_${String(scene.index).padStart(3, "0")}.mp3`);

    if (existsSync(scenePath) && statSync(scenePath).size > 1000) {
      const dur = ffprobeDuration(scenePath);
      results.push({ sceneIndex: scene.index, audioPath: scenePath, durationSeconds: dur });
      console.log(`  Scene ${scene.index}: ${dur.toFixed(2)}s (cache)`);
      continue;
    }

    let buf = null;
    for (let a = 1; a <= 3; a++) {
      try { buf = await generateVoiceoverChunk(apiKey, voiceId, scene.narration); break; }
      catch (e) {
        console.warn(`  Scene ${scene.index} tentative ${a}/3: ${e.message}`);
        if (a < 3) await sleep(a * 3000); else throw e;
      }
    }
    writeFileSync(scenePath, buf);
    const dur = ffprobeDuration(scenePath);
    results.push({ sceneIndex: scene.index, audioPath: scenePath, durationSeconds: dur });
    console.log(`  Scene ${scene.index}: "${scene.narration.slice(0, 50)}..." → ${dur.toFixed(2)}s`);
    await sleep(400); // petit delay entre appels ElevenLabs
  }
  return results;
}

/**
 * Concat les audios scene en un seul voiceover.mp3 pour le montage final.
 */
function concatSceneAudios(sceneAudios, outputPath) {
  const concatFile = path.join(path.dirname(outputPath), "voiceover_scenes_concat.txt");
  writeFileSync(concatFile, sceneAudios.map((s) => `file '${path.resolve(s.audioPath)}'`).join("\n"));
  // -c copy avec demuxer concat introduit ~30-40ms de silence par boundary mp3 a cause
  // du frame alignement → sur 281 scenes ça fait +10s de drift cumule entre l'audio
  // et la timeline video. On re-encode en libmp3lame pour avoir un concat sample-accurate.
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -b:a 192k "${outputPath}"`, { stdio: "pipe" });
  try { unlinkSync(concatFile); } catch { }
}

// ===================== STEP 5: MONTAGE (full video — concat clips seedance) =====================
function generateASS(scenes, timeline) {
  let header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n`;
  header += `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;
  header += `Style: Default,Arial,52,&H0000FFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,2,2,20,20,60,1\n\n`;
  header += `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const sceneDurations = {};
  for (const seg of timeline) {
    const si = seg.sceneIndex;
    if (si === undefined) continue;
    sceneDurations[si] = (sceneDurations[si] || 0) + seg.durationSeconds;
  }

  const events = [];
  let t = 0;
  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const cs = Math.round((s % 1) * 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  };

  for (const scene of scenes) {
    const realDur = sceneDurations[scene.index] || scene.durationSeconds;
    const words = scene.narration.split(/\s+/);
    const chunks = [];
    for (let j = 0; j < words.length; j += 5) chunks.push(words.slice(j, j + 5).join(" "));
    const dur = realDur / (chunks.length || 1);
    chunks.forEach((chunk, j) => {
      events.push(`Dialogue: 0,${fmt(t + j * dur)},${fmt(t + (j + 1) * dur)},Default,,0,0,0,,${chunk}`);
    });
    t += realDur;
  }
  return header + events.join("\n");
}

function assembleMontage(scenes, clips, audioPath, outputPath) {
  const videoOnlyMode = !audioPath;              // pas d'audio → juste concat
  const burnSubs = !videoOnlyMode && !SKIP_SUBTITLES;
  const assPath = path.join(path.dirname(outputPath), "subtitles.ass");

  const clipsByScene = new Map();
  clips.forEach((c) => {
    if (!clipsByScene.has(c.sceneIndex)) clipsByScene.set(c.sceneIndex, []);
    clipsByScene.get(c.sceneIndex).push(c);
  });

  const timeline = [];
  for (const scene of scenes) {
    const sceneClips = (clipsByScene.get(scene.index) || []).sort((a, b) => a.clipIndex - b.clipIndex);
    if (sceneClips.length === 0) {
      console.warn(`  Scene ${scene.index} : aucun clip — scene ignoree au montage`);
      continue;
    }
    for (const clip of sceneClips) {
      timeline.push({
        filePath: clip.clipPath,
        durationSeconds: clip.durationSeconds,
        sceneIndex: scene.index,
        kind: clip.kind || "video",
      });
    }
  }

  // Note: plus besoin de scaling global ici — avec le voiceover per-scene,
  // seg.durationSeconds contient deja la vraie duree audio (ffprobe) de chaque phrase,
  // donc sum(segments) == duree audio totale par construction.

  const modeLabel = videoOnlyMode
    ? " (video-only, no audio, no subs)"
    : burnSubs
      ? " (audio + subs)"
      : " (audio, no subs)";
  console.log(`  Timeline: ${timeline.length} clips${modeLabel}`);

  if (burnSubs) writeFileSync(assPath, generateASS(scenes, timeline));

  const CHUNK_SIZE = 30;
  const chunksDir = path.join(path.dirname(outputPath), "chunks");
  if (!existsSync(chunksDir)) mkdirSync(chunksDir, { recursive: true });
  const chunkFiles = [];

  for (let ci = 0; ci < timeline.length; ci += CHUNK_SIZE) {
    const chunk = timeline.slice(ci, ci + CHUNK_SIZE);
    const chunkPath = path.join(chunksDir, `chunk_${String(ci).padStart(4, "0")}.ts`);

    if (existsSync(chunkPath) && statSync(chunkPath).size > 1000) {
      console.log(`  Chunk ${Math.floor(ci / CHUNK_SIZE) + 1}/${Math.ceil(timeline.length / CHUNK_SIZE)} (cache)`);
      chunkFiles.push(chunkPath);
      continue;
    }

    // Inputs : video (mp4 seedance) → -an, image (png static) → -loop 1 -framerate FPS -t dur.
    // Ces directives sont AVANT le -i, sinon ffmpeg les ignore. La duree -t cote input fait
    // que l'image est encodee comme un mini-clip de duree 'dur' avant le filter chain.
    // CRITIQUE : pour les images static (source = -loop -t dur EXACT), le trim filter
    // veut 'dur + TRANSITION_DUR' pour absorber l'overlap xfade. Donc on doit aussi etendre
    // l'input -t a (dur + TRANSITION_DUR) pour les segments non-derniers du chunk, sinon
    // ffmpeg cape silencieusement a 'dur' et la chaine xfade casse.
    const inputs = chunk.map((seg, i) => {
      const isLast = i === chunk.length - 1;
      const inputDur = isLast ? seg.durationSeconds : seg.durationSeconds + TRANSITION_DUR;
      if (seg.kind === "image") {
        return `-loop 1 -framerate ${FPS} -t ${inputDur.toFixed(4)} -i "${seg.filePath}"`;
      }
      return `-an -i "${seg.filePath}"`;
    });

    // Sync audio/video : xfade(duration=T) consomme T secondes a chaque transition,
    // donc si on trim chaque clip a sa duree audio "nominale", la timeline video se
    // raccourcit de (N-1)*T par rapport a l'audio (qui est concatene sans overlap).
    // Correctif : on trim chaque clip a (audio_dur + T) sauf le dernier qui reste audio_dur,
    // et on fixe les offsets xfade aux instants audio cumules. Resultat : duree video totale
    // == duree audio totale, scene K visible solo sur [sum(audio_0..K-1) + T, sum(audio_0..K)].
    const trimDurOf = (i) => i === chunk.length - 1
      ? chunk[i].durationSeconds
      : chunk[i].durationSeconds + TRANSITION_DUR;
    const filters = chunk.map((_, i) =>
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=${FPS},setsar=1,trim=duration=${trimDurOf(i).toFixed(4)},setpts=PTS-STARTPTS[v${i}]`,
    );

    if (chunk.length > 1 && TRANSITION_DUR > 0) {
      let prevLabel = "v0";
      let offset = chunk[0].durationSeconds; // O_1 = audio_0 (xfade demarre pile a la fin de l'audio scene 0)
      for (let i = 1; i < chunk.length; i++) {
        const outLabel = i === chunk.length - 1 ? "outv" : `x${String(i).padStart(2, "0")}`;
        filters.push(`[${prevLabel}][v${i}]xfade=transition=fade:duration=${TRANSITION_DUR.toFixed(2)}:offset=${Math.max(0, offset).toFixed(2)}[${outLabel}]`);
        prevLabel = outLabel;
        if (i < chunk.length - 1) offset += chunk[i].durationSeconds; // O_(i+1) = O_i + audio_i
      }
    } else if (chunk.length === 1) {
      filters.push(`[v0]copy[outv]`);
    } else {
      const concatInputs = chunk.map((_, i) => `[v${i}]`).join("");
      filters.push(`${concatInputs}concat=n=${chunk.length}:v=1:a=0[outv]`);
    }

    const filterComplex = filters.join(";");
    const cmd = `ffmpeg -y ${inputs.join(" ")} -filter_complex "${filterComplex}" -map "[outv]" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -r ${FPS} -an "${chunkPath}"`;

    console.log(`  Chunk ${Math.floor(ci / CHUNK_SIZE) + 1}/${Math.ceil(timeline.length / CHUNK_SIZE)} (${chunk.length} segments)...`);
    execSync(cmd, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
    chunkFiles.push(chunkPath);
  }

  const videoDuration = timeline.reduce((s, seg) => s + seg.durationSeconds, 0);
  console.log(`  Duree video: ${Math.round(videoDuration)}s`);

  const concatFile = path.join(chunksDir, "concat.txt");
  writeFileSync(concatFile, chunkFiles.map((f) => `file '${path.resolve(f)}'`).join("\n"));

  if (videoOnlyMode) {
    // Juste concat + re-encode propre, pas d'audio, pas de subs
    execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -an -movflags +faststart "${outputPath}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
    const size = statSync(outputPath).size;
    console.log(`  Video finale (video-only): ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
    return;
  }

  const trimmedAudio = path.join(path.dirname(outputPath), "voiceover_trimmed.mp3");
  try {
    execSync(`ffmpeg -y -i "${audioPath}" -t ${videoDuration.toFixed(2)} -c copy "${trimmedAudio}"`, { stdio: "pipe" });
  } catch {
    writeFileSync(trimmedAudio, readFileSync(audioPath));
  }

  const videoOnly = outputPath.replace(/\.mp4$/, "_videoonly.mp4");
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v copy -an "${videoOnly}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });

  // Si pas de subs a bruler, on sort direct avec audio
  if (!burnSubs) {
    execSync(`ffmpeg -y -i "${videoOnly}" -i "${trimmedAudio}" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${outputPath}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
    try { unlinkSync(videoOnly); } catch { }
    try { unlinkSync(trimmedAudio); } catch { }
    const size = statSync(outputPath).size;
    console.log(`  Video finale (audio, no subs): ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
    return;
  }

  // Sinon : pass 2 (audio mux) puis pass 3 (subtitle burn)
  const tempPath = outputPath.replace(/\.mp4$/, "_nosub.mp4");
  execSync(`ffmpeg -y -i "${videoOnly}" -i "${trimmedAudio}" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${tempPath}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });

  const cmd3 = `ffmpeg -y -i "${tempPath}" -vf "subtitles=${path.resolve(assPath)}" -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -c:a copy "${outputPath}"`;
  try {
    execSync(cmd3, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
    try { unlinkSync(tempPath); } catch { }
    try { unlinkSync(videoOnly); } catch { }
    try { unlinkSync(trimmedAudio); } catch { }
  } catch {
    try { renameSync(tempPath, outputPath); } catch { }
  }

  const size = statSync(outputPath).size;
  console.log(`  Video finale: ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
}

// ===================== MAIN =====================
async function main() {
  console.log("=== YAKUZA PIPELINE — wan-2.7/image-edit + bytedance/seedance-v1-pro-fast/image-to-video ===\n");

  const scriptPath = process.argv[2] || DEFAULT_SCRIPT_PATH;
  if (!existsSync(scriptPath)) {
    console.error(`Script introuvable : ${scriptPath}`);
    console.error(`Pose ton script narration ici puis relance.`);
    process.exit(1);
  }

  const config = loadConfig();
  const styleKit = loadStyleKit(STYLE_KIT_PATH);
  console.log(`Style kit : seed=${styleKit.project_seed} hash=${styleKit._hash.slice(0, 8)} refs=${styleKit.style_refs.length}\n`);

  const imagesDir = path.join(JOB_DIR, "images");
  const clipsDir = path.join(JOB_DIR, "clips");
  const cachePath = path.join(JOB_DIR, "images_results.json");
  for (const d of [JOB_DIR, imagesDir, clipsDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // 1. Load narration script
  console.log(`[1/5] Chargement narration : ${scriptPath}`);
  const fullScript = readFileSync(scriptPath, "utf-8").trim();
  console.log(`  ${fullScript.split(/\s+/).length} mots\n`);

  // Hash = fingerprint du script + config + version du prompt Claude. Si on modifie le
  // prompt d'annotation, bump PARSE_PROMPT_VERSION → invalidation auto, plus besoin de
  // rm script.json manuellement.
  const PARSE_PROMPT_VERSION = "v3-yakuza-fr-age-aware";
  const parseFingerprint = (() => {
    const hasher = createHash("md5");
    hasher.update(fullScript);
    hasher.update(`wpm=${WPM}|min=${CLIP_DUR_MIN}|max=${CLIP_DUR_MAX}|prompt=${PARSE_PROMPT_VERSION}`);
    return hasher.digest("hex");
  })();

  // 2. Parse scenes : 1 phrase = 1 scene (split sur .!?)
  const scriptJsonPath = path.join(JOB_DIR, "script.json");
  let allScenes;
  let cachedValid = false;
  if (existsSync(scriptJsonPath) && statSync(scriptJsonPath).size > 100) {
    const cached = JSON.parse(readFileSync(scriptJsonPath, "utf-8"));
    if (cached.parseFingerprint === parseFingerprint && Array.isArray(cached.scenes)) {
      allScenes = cached.scenes;
      cachedValid = true;
      console.log(`[2/5] Scenes deja parsees — ${allScenes.length} scenes (cache, fingerprint match)\n`);
    } else {
      console.log(`[2/5] Cache script.json obsolete (script ou config a change) — re-parse\n`);
    }
  }
  if (!cachedValid) {
    console.log("[2/5] Parsing des scenes (1 phrase = 1 scene)...");
    const apiKey = config.anthropicKey;
    if (!apiKey) throw new Error("config.anthropicKey manquante pour le parsing de scenes");

    // Segments = unites clip (phrase, ou sous-segment si phrase longue splittee sur virgule)
    const sentences = splitIntoClipSegments(fullScript);
    console.log(`  ${sentences.length} segments detectes (phrases + splits virgule)`);

    // Batching : SENTENCES_PER_CALL phrases par appel Claude, SCENE_PARSE_BATCH appels en parallele
    // On passe tout le script en contexte pour la continuite narrative → peu importe la taille
    // du batch, Claude voit l'arc complet.
    const SENTENCES_PER_CALL = 10;
    const chunks = [];
    for (let i = 0; i < sentences.length; i += SENTENCES_PER_CALL) {
      chunks.push({ start: i, items: sentences.slice(i, i + SENTENCES_PER_CALL) });
    }

    allScenes = [];
    for (let i = 0; i < chunks.length; i += SCENE_PARSE_BATCH) {
      const parallelChunks = chunks.slice(i, i + SCENE_PARSE_BATCH);
      const results = await Promise.all(
        parallelChunks.map((chunk) =>
          annotateSentenceBatch(apiKey, chunk.items, chunk.start, sentences.length, fullScript),
        ),
      );
      for (let k = 0; k < parallelChunks.length; k++) {
        const chunk = parallelChunks[k];
        const annotations = results[k];
        for (let m = 0; m < chunk.items.length; m++) {
          allScenes.push(sentenceToScene(chunk.items[m], annotations[m], allScenes.length));
        }
      }
      const parsedDur = allScenes.reduce((s, sc) => s + sc.durationSeconds, 0);
      console.log(`  ${allScenes.length}/${sentences.length} phrases (~${Math.round(parsedDur)}s)`);
      if (MAX_DURATION_S > 0 && parsedDur >= MAX_DURATION_S + 60) break;
      if (i + SCENE_PARSE_BATCH < chunks.length) await sleep(300);
    }

    writeFileSync(scriptJsonPath, JSON.stringify({ parseFingerprint, scenes: allScenes }, null, 2));
    console.log(`  → ${scriptJsonPath}\n`);
  }

  // Trim to MAX_DURATION_S — cap strict : on n'ajoute pas une scene qui ferait depasser
  if (MAX_DURATION_S > 0) {
    let cumDur = 0;
    const trimmed = [];
    for (const scene of allScenes) {
      if (cumDur + scene.durationSeconds > MAX_DURATION_S && trimmed.length > 0) break;
      trimmed.push(scene);
      cumDur += scene.durationSeconds;
    }
    allScenes = trimmed;
    console.log(`  Trimme a ${MAX_DURATION_S}s : ${allScenes.length} scenes (~${Math.round(cumDur)}s)\n`);
  }

  if (MAX_SCENES > 0 && allScenes.length > MAX_SCENES) {
    allScenes = allScenes.slice(0, MAX_SCENES);
    console.log(`  Trimme a ${MAX_SCENES} scenes (flag --limit)\n`);
  }

  // === --parse-only : arret ici pour que tu valides le JSON avant le reste ===
  if (process.argv.includes("--parse-only")) {
    const trimmedJsonPath = path.join(JOB_DIR, "script-trimmed.json");
    writeFileSync(trimmedJsonPath, JSON.stringify({ scenes: allScenes }, null, 2));
    const nMain = allScenes.filter((s) => s.hasMainCharacter !== false).length;
    const nNoChar = allScenes.length - nMain;
    console.log(`>>> --parse-only : ${allScenes.length} scenes (${nMain} avec perso, ${nNoChar} sans perso)`);
    console.log(`>>> JSON full    : ${scriptJsonPath}`);
    console.log(`>>> JSON trimme  : ${trimmedJsonPath}`);
    console.log(`>>> Inspecte puis relance sans --parse-only pour continuer.`);
    return;
  }

  // === --script-only : export markdown lisible pour review humaine (gate 1) ===
  //   Narration + timing prevu + shot type. Pas d'appel image/voice/Kling.
  if (process.argv.includes("--script-only")) {
    const mdPath = path.join(JOB_DIR, "script.md");
    const lines = [];
    lines.push(`# Script — ${path.basename(scriptPath)}`);
    lines.push("");
    const totalDur = allScenes.reduce((s, sc) => s + (sc.narrationDurationSeconds || sc.durationSeconds), 0);
    lines.push(`**${allScenes.length} scenes** • **${Math.round(totalDur)}s** (estimation WPM=${WPM})`);
    lines.push("");
    let cumul = 0;
    for (const sc of allScenes) {
      const narr = sc.narrationDurationSeconds || sc.durationSeconds;
      const start = cumul;
      const end = cumul + narr;
      cumul = end;
      const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
      const tag = sc.hasMainCharacter !== false ? "CHAR" : "env";
      lines.push(`## Scene ${sc.index} — ${fmt(start)}→${fmt(end)} (${narr.toFixed(1)}s) · ${tag} · \`${sc.locationId || "?"}\``);
      lines.push("");
      lines.push(`> ${sc.narration.replace(/\n/g, " ")}`);
      lines.push("");
      if (sc.sceneDescription) {
        lines.push(`**Visuel :** ${sc.sceneDescription}`);
        lines.push("");
      }
      if (sc.expression) {
        lines.push(`**Expression :** ${sc.expression}`);
        lines.push("");
      }
    }
    writeFileSync(mdPath, lines.join("\n"));
    console.log(`>>> --script-only : ${mdPath}`);
    console.log(`>>> ${allScenes.length} scenes, ~${Math.round(totalDur)}s total.`);
    return;
  }

  // 3. Voiceover PER-SCENE (1 appel ElevenLabs par scene + ffprobe pour duree reelle)
  const audioPath = path.join(JOB_DIR, "voiceover.mp3");
  const voiceDir = path.join(JOB_DIR, "voiceover");
  let voiceover = null;
  if (SKIP_VOICE) {
    console.log("[3/5] Voiceover skip (SKIP_VOICE=true, montage video-only)\n");
  } else {
    console.log("[3/5] Voiceover per-scene (ElevenLabs)...");
    const sceneAudios = await generateVoiceoverPerScene(config, allScenes, voiceDir);
    if (sceneAudios) {
      // Injecte audioDurationSeconds dans chaque scene (utilise comme reference de trim)
      for (const a of sceneAudios) {
        const sc = allScenes.find((s) => s.index === a.sceneIndex);
        if (sc) sc.audioDurationSeconds = a.durationSeconds;
      }
      // Concatene les scene-audios en un voiceover.mp3 unique pour le mux final
      concatSceneAudios(sceneAudios, audioPath);
      const totalDur = sceneAudios.reduce((s, a) => s + a.durationSeconds, 0);
      voiceover = { audioPath, durationSeconds: totalDur };
      console.log(`  Total voix: ${totalDur.toFixed(2)}s → ${audioPath}`);
    }
    console.log("");
  }

  // 4. Images via wan-2.7/image-edit
  //    Deux modes selon position dans la video :
  //    - ANIMATED (accroche, sum(audioDur) <= ANIMATED_INTRO_SECONDS) :
  //        scene decoupee en sous-clips 4-7s, 1 image par sous-clip, I2V seedance dessus.
  //    - STATIC (reste de la video) :
  //        scene decoupee en chunks de max STATIC_IMAGE_MAX_DURATION secondes,
  //        1 image par chunk, PAS d'I2V (image affichee telle quelle, crossfade au montage).
  const animatedSceneIndices = new Set();
  {
    let cumDur = 0;
    for (const scene of allScenes) {
      const sceneDur = scene.audioDurationSeconds ?? scene.narrationDurationSeconds ?? scene.durationSeconds;
      // Toujours au moins la 1ere scene (accroche garantie meme si > seuil).
      if (cumDur < ANIMATED_INTRO_SECONDS || animatedSceneIndices.size === 0) {
        animatedSceneIndices.add(scene.index);
        cumDur += sceneDur;
      } else {
        break;
      }
    }
  }
  const animatedDurEst = allScenes
    .filter((s) => animatedSceneIndices.has(s.index))
    .reduce((acc, s) => acc + (s.audioDurationSeconds ?? s.narrationDurationSeconds ?? s.durationSeconds), 0);
  const staticDurEst = allScenes
    .filter((s) => !animatedSceneIndices.has(s.index))
    .reduce((acc, s) => acc + (s.audioDurationSeconds ?? s.narrationDurationSeconds ?? s.durationSeconds), 0);
  console.log(`  Accroche animee : ${animatedSceneIndices.size} scenes (~${Math.round(animatedDurEst)}s, seuil ${ANIMATED_INTRO_SECONDS}s)`);
  console.log(`  Static + xfade  : ${allScenes.length - animatedSceneIndices.size} scenes (~${Math.round(staticDurEst)}s, max ${STATIC_IMAGE_MAX_DURATION}s/image)`);

  const clipPlan = []; // [{kind, scene, ci, dur, framing, imgPath, clipPath?, imgSceneKey}]
  for (const scene of allScenes) {
    const isAnimated = animatedSceneIndices.has(scene.index);
    const framingPool = scene.hasMainCharacter ? FRAMING_VARIANTS_CHAR : FRAMING_VARIANTS_ENV;
    if (isAnimated) {
      const clipDurations = splitSceneIntoClipDurations(scene.durationSeconds);
      for (let ci = 0; ci < clipDurations.length; ci++) {
        const dur = clipDurations[ci];
        const framing = framingPool[ci % framingPool.length];
        const imgPath = path.join(imagesDir, `scene_${String(scene.index).padStart(3, "0")}_c${ci}.png`);
        const clipPath = path.join(clipsDir, `clip_${String(scene.index).padStart(3, "0")}_${ci}_${dur}s.mp4`);
        const imgSceneKey = `${scene.index}_c${ci}`;
        clipPlan.push({ kind: "animated", scene, ci, dur, framing, imgPath, clipPath, imgSceneKey });
      }
    } else {
      const sceneDur = scene.audioDurationSeconds ?? scene.narrationDurationSeconds ?? scene.durationSeconds;
      const chunks = splitStaticSceneIntoImageChunks(sceneDur);
      for (let ci = 0; ci < chunks.length; ci++) {
        const dur = chunks[ci];
        const framing = framingPool[ci % framingPool.length];
        const imgPath = path.join(imagesDir, `scene_${String(scene.index).padStart(3, "0")}_s${ci}.png`);
        const imgSceneKey = `${scene.index}_s${ci}`;
        clipPlan.push({ kind: "static", scene, ci, dur, framing, imgPath, clipPath: null, imgSceneKey });
      }
    }
  }

  console.log(`[4/5] Images (wan-2.7/image-edit) — ${clipPlan.length} images au total (anime: 1 par sous-clip, static: 1 par chunk de ${STATIC_IMAGE_MAX_DURATION}s)`);
  const imageResults = new Map(); // imgSceneKey → {imagePath, prompt}

  // Coherence visuelle par location : on genere d'abord l'anchor de chaque locationId unique
  // (1er scene qui l'utilise), puis les autres scenes de la meme location avec l'anchor en
  // reference additionnelle → decor visuellement coherent entre scenes partageant un lieu.
  const locationAnchors = new Map(); // locationId → imagePath de l'anchor
  const anchorSceneIndex = new Map(); // locationId → index de la 1ere scene dans clipPlan
  for (let k = 0; k < clipPlan.length; k++) {
    const t = clipPlan[k];
    const loc = t.scene.locationId || "generic_scene";
    if (!anchorSceneIndex.has(loc)) anchorSceneIndex.set(loc, k);
  }
  const anchorClipIdxs = new Set(anchorSceneIndex.values());
  const anchorTasks = clipPlan.filter((_, i) => anchorClipIdxs.has(i));
  const dependentTasks = clipPlan.filter((_, i) => !anchorClipIdxs.has(i));
  console.log(`  Locations: ${anchorTasks.length} anchors (${[...anchorSceneIndex.keys()].join(", ")}), ${dependentTasks.length} dependents`);

  const runBatch = async (tasks, passLabel) => {
    for (let i = 0; i < tasks.length; i += IMAGE_BATCH_SIZE) {
      const batch = tasks.slice(i, i + IMAGE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (t) => {
          try {
            // Priorite: generation.imagePrompt pre-construit par Claude (schema v2 nested).
            // Fallback: sceneDescription + characterPlacement + framing (legacy).
            let sceneDesc;
            if (t.scene.generation?.imagePrompt) {
              sceneDesc = t.scene.generation.imagePrompt;
              // On ajoute characterPlacement si pas deja evoque (doublon pas grave)
              if (t.scene.hasMainCharacter && t.scene.characterPlacement) {
                sceneDesc += `. Expert placement: ${t.scene.characterPlacement}`;
              }
            } else {
              const framingForImage = (t.scene.hasMainCharacter && t.scene.characterPlacement)
                ? t.scene.characterPlacement
                : t.framing;
              sceneDesc = `${t.scene.sceneDescription}, ${framingForImage}`;
            }
            const seedOffset = t.scene.index * 1000 + t.ci * 37 + Math.floor(Math.random() * 5000); // Randomisé pour ne pas refaire exactement les memes images horribles
            const loc = t.scene.locationId || "generic_scene";
            const anchorPath = locationAnchors.get(loc);
            const additionalRefs = anchorPath && passLabel === "dependents" ? [anchorPath] : [];
            const r = await generateSceneImageCached({
              config,
              sceneKey: t.imgSceneKey,
              sceneDescription: sceneDesc,
              styleKit,
              outputPath: t.imgPath,
              cachePath,
              hasMainCharacter: t.scene.hasMainCharacter,
              expression: t.scene.expression || "",
              seedOffset,
              additionalRefs,
            });
            if (passLabel === "anchors") locationAnchors.set(loc, r.imagePath);
            return { key: t.imgSceneKey, imagePath: r.imagePath, prompt: r.prompt };
          } catch (e) {
            console.warn(`  [Image] ${t.imgSceneKey} echec: ${e.message}`);
            return null;
          }
        }),
      );
      results.filter(Boolean).forEach((r) => imageResults.set(r.key, r));
      console.log(`  [${passLabel}] ${imageResults.size}/${clipPlan.length}`);
      if (i + IMAGE_BATCH_SIZE < tasks.length) await sleep(300);
    }
  };

  // Pass 1: anchors (en parallele, pas de dep entre elles)
  if (process.argv.includes("--skip-images")) {
    console.log(">>> --skip-images : On saute la generation et on recupere directement les images existantes !");
    for (const t of clipPlan) {
      if (existsSync(t.imgPath)) {
        imageResults.set(t.imgSceneKey, { key: t.imgSceneKey, imagePath: t.imgPath, prompt: "skipped" });
      } else {
        console.warn(`  [ATTENTION] Image manquante pour le clip: ${t.imgPath}`);
      }
    }
  } else {
    await runBatch(anchorTasks, "anchors");
    // Pass 2: dependents (utilisent les anchors generees a pass 1)
    await runBatch(dependentTasks, "dependents");
  }
  console.log("");

  // === --style-pack : arret ici, on a deja images (anchors) + voix scene-by-scene.
  //     Parfait pour review "style + voice" (gate 2) sans payer Kling. ===
  if (process.argv.includes("--style-pack")) {
    const styleDir = path.join(JOB_DIR, "style-pack");
    if (!existsSync(styleDir)) mkdirSync(styleDir, { recursive: true });
    // Copy les anchors (1 par location unique) dans style-pack/anchors/
    const anchorsOut = path.join(styleDir, "anchors");
    if (!existsSync(anchorsOut)) mkdirSync(anchorsOut, { recursive: true });
    for (const [loc, anchorPath] of locationAnchors.entries()) {
      if (!anchorPath || !existsSync(anchorPath)) continue;
      const dest = path.join(anchorsOut, `${loc}.png`);
      writeFileSync(dest, readFileSync(anchorPath));
    }
    // Voiceover deja concatene dans audioPath si per-scene a tourne
    const voicePackPath = path.join(styleDir, "voice-sample.mp3");
    if (voiceover && existsSync(voiceover.audioPath)) {
      writeFileSync(voicePackPath, readFileSync(voiceover.audioPath));
    }
    console.log(`>>> --style-pack : ${styleDir}`);
    console.log(`    anchors     : ${anchorsOut} (${locationAnchors.size} images)`);
    if (voiceover) console.log(`    voice       : ${voicePackPath} (${voiceover.durationSeconds.toFixed(1)}s)`);
    console.log(`>>> Gate 2 : envoie ce dossier pour valider le style + voix avant Kling.`);
    return;
  }

  // === GATE : confirmation humaine avant l'etape couteuse (I2V) ===
  const animatedPlan = clipPlan.filter((t) => t.kind === "animated");
  const staticPlan = clipPlan.filter((t) => t.kind === "static");
  const totalAnimS = animatedPlan.reduce((s, t) => s + t.dur, 0);
  console.log(`>>> Images generees dans ${imagesDir}`);
  console.log(`>>> Inspecte-les visuellement. Prochaine etape :`);
  console.log(`>>>   - I2V seedance : ${animatedPlan.length} clips (~${Math.round(totalAnimS)}s, COUTEUX)`);
  console.log(`>>>   - Static       : ${staticPlan.length} images (pas d'I2V, image-to-video local)`);
  const go = await askConfirm(">>> Continuer vers generation des clips video ? (y/N) ");
  if (!go) {
    console.log("\nArret apres generation des images. Relance le script pour reprendre a l'etape clips.");
    return;
  }
  console.log("");

  // 5. I2V bytedance/seedance-v1-pro-fast/image-to-video — UNIQUEMENT scenes "animated" (accroche)
  console.log(`[5/5] Animation I2V bytedance/seedance-v1-pro-fast/image-to-video — ${animatedPlan.length} clips animes (sur ${clipPlan.length} segments totaux), ~${Math.round(totalAnimS)}s`);
  const allClips = [];

  const clipTasks = [];
  // Pre-compute pour chaque scene la somme des durations de ses sous-clips animes.
  // Sert a distribuer audioDur proportionnellement entre sous-clips (sinon une scene
  // splittee en N >= 2 sous-clips voit chaque sous-clip trim a min(dur, audio_FULL)
  // → video totale par scene = sum(dur) > audio → drift inter-scene).
  const animatedClipDurSumBySceneIndex = new Map();
  for (const t of animatedPlan) {
    const cur = animatedClipDurSumBySceneIndex.get(t.scene.index) || 0;
    animatedClipDurSumBySceneIndex.set(t.scene.index, cur + t.dur);
  }

  for (const t of animatedPlan) {
    const imgEntry = imageResults.get(t.imgSceneKey);
    if (!imgEntry) {
      console.warn(`  Pas d'image pour ${t.imgSceneKey} — clip ignore`);
      continue;
    }
    // trimDur = duree reelle a garder au montage.
    //   Priorite 1 : audioDurationSeconds (vraie duree MP3 ElevenLabs via ffprobe) = sync parfait
    //   Priorite 2 : narrationDurationSeconds (estimation WPM) si pas de voiceover per-scene
    //   Priorite 3 : t.dur (duree clip Kling) en dernier recours
    // Pour scenes splittees en N sous-clips : on alloue audioDur * (t.dur / sum_dur_scene)
    // a chaque sous-clip → sum(trim_subclips) == audioDur. Sans ça, chaque sous-clip prend
    // min(t.dur, audio_FULL) ce qui donne sum(trim) == sum(t.dur) > audio.
    const sceneFullAudioDur = t.scene.audioDurationSeconds ?? t.scene.narrationDurationSeconds ?? t.dur;
    const sumClipsDurForScene = animatedClipDurSumBySceneIndex.get(t.scene.index) || t.dur;
    const audioForThisSubclip = sceneFullAudioDur * (t.dur / sumClipsDurForScene);
    const trimDur = Math.max(0.5, Math.min(t.dur, audioForThisSubclip));
    if (existsSync(t.clipPath) && statSync(t.clipPath).size > 10000) {
      allClips.push({ sceneIndex: t.scene.index, clipPath: t.clipPath, durationSeconds: trimDur, clipIndex: t.ci, kind: "video" });
      continue;
    }
    // Motion prompt riche pour seedance v1 pro fast :
    //   1. Reprend l'annotation per-scene (motion.environment + motion.character + motion.camera)
    //      qui contient deja une description sur-mesure (ex: "rain falls vertically...; camera: slow push-in down the alley").
    //   2. Ajoute des garde-fous globaux pour preserver le style 2D cel-shading (jamais de morph,
    //      pas de derive realiste des visages blancs ronds).
    //   3. Capping: subtil, cinematic, pas de zoom violent ni d'effets dramatiques.
    const sceneMotion = (t.scene.cameraMotion || "static camera, subtle atmospheric drift").trim();
    const motionPrompt = [
      sceneMotion,
      "Subtle cinematic motion only — preserve the 2D cel-shaded children's-book look at every frame.",
      "Faces stay perfectly flat white circles with only dot eyes and a thin mouth line — no morphing, no rotation of facial features, no realistic skin emerging.",
      "Bold black outlines stay crisp and uniform on all characters and props.",
      "Avoid any sudden zoom, shake, or dramatic action; movement is slow and atmospheric.",
    ].join(" ");
    clipTasks.push({ scene: t.scene, ci: t.ci, dur: t.dur, trimDur, imgPath: imgEntry.imagePath, clipPath: t.clipPath, motionPrompt });
  }

  const totalClipsExpected = allClips.length + clipTasks.length;
  console.log(`  ${clipTasks.length} clips a generer, ${allClips.length} deja en cache (total ${totalClipsExpected})`);

  for (let i = 0; i < clipTasks.length; i += CLIP_BATCH_SIZE) {
    const batch = clipTasks.slice(i, i + CLIP_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (t) => {
        try {
          const r = await generateI2VClipWithRetry({
            config,
            imagePath: t.imgPath,
            motionPrompt: t.motionPrompt,
            outputPath: t.clipPath,
            durationSec: t.dur,
            resolution: I2V_RESOLUTION,
            clipLabel: `s${t.scene.index}[${t.ci}]`,
            seed: styleKit.project_seed,
          });
          return { sceneIndex: t.scene.index, clipPath: r.clipPath, durationSeconds: t.trimDur, clipIndex: t.ci, kind: "video" };
        } catch (e) {
          console.warn(`  [I2V] s${t.scene.index}[${t.ci}] echec: ${e.message}`);
          return null;
        }
      }),
    );
    results.filter(Boolean).forEach((r) => allClips.push(r));
    console.log(`  ${allClips.length}/${totalClipsExpected} clips (batch ${Math.floor(i / CLIP_BATCH_SIZE) + 1}/${Math.ceil(clipTasks.length / CLIP_BATCH_SIZE)})`);
    if (i + CLIP_BATCH_SIZE < clipTasks.length) await sleep(300);
  }
  // Tag les clips deja en cache avec kind: "video" (omitted plus haut quand on push sans passer par seedance).
  for (const c of allClips) {
    if (!c.kind) c.kind = "video";
  }
  // Ajout des segments STATIC : 1 segment par image, affichee 'dur' secondes au montage.
  let staticAdded = 0;
  for (const t of staticPlan) {
    const imgEntry = imageResults.get(t.imgSceneKey);
    if (!imgEntry) {
      console.warn(`  [Static] Pas d'image pour ${t.imgSceneKey} — segment ignore`);
      continue;
    }
    allClips.push({
      sceneIndex: t.scene.index,
      clipPath: imgEntry.imagePath,
      durationSeconds: t.dur,
      clipIndex: t.ci,
      kind: "image",
    });
    staticAdded++;
  }
  if (staticAdded > 0) console.log(`  + ${staticAdded} segments static (images affichees telles quelles)`);
  console.log("");

  // 6. Montage
  const modeTag = SKIP_VOICE ? "video-only" : SKIP_SUBTITLES ? "audio, no subs" : "audio + subs";
  console.log(`[Montage] FFmpeg (${modeTag})`);
  const outputPath = path.join(JOB_DIR, "output.mp4");
  assembleMontage(allScenes, allClips, voiceover ? audioPath : null, outputPath);

  console.log("\n=== PIPELINE TERMINE ===");
  console.log(`Video  : ${outputPath}`);
  console.log(`Scenes : ${allScenes.length}`);
  console.log(`Images : ${imageResults.size}`);
  console.log(`Clips  : ${allClips.length}`);
}

main().catch((err) => {
  console.error("ERREUR FATALE:", err);
  process.exit(1);
});
