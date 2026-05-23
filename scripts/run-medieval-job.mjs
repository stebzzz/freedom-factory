#!/usr/bin/env node
/**
 * run-medieval-job.mjs — pipeline dedie serie storytime medieval
 *
 *   - Narration : scripts/script-medieval.txt (1er arg CLI aussi accepte)
 *   - Images    : WaveSpeed wan-2.7/image-edit + style-kit.json
 *                 → coherence perso/style verrouillee par refs + seed
 *   - I2V       : bytedance/seedance-v1-pro-fast/image-to-video (WaveSpeed), video-only
 *   - Voiceover : ElevenLabs (reprise run-sleepy-job.mjs)
 *   - Montage   : FFmpeg Ken Burns + particules + subtitles ASS (reprise sleepy)
 *
 * Usage : node scripts/run-medieval-job.mjs [path/to/script.txt]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from "fs";
import { execSync } from "child_process";
import { createHash } from "crypto";
import https from "https";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

import {
  loadStyleKit,
  generateSceneImageCached,
  generateI2VClipWithRetry,
} from "./lib-wan-image.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ===================== CONFIG =====================
// Permet de lancer des tests dans un dossier different sans casser l'existant:
//   JOB_DIR=job_caesar_v2 node scripts/run-medieval-job.mjs ...
const JOB_DIR = process.env.JOB_DIR
  ? path.isAbsolute(process.env.JOB_DIR)
    ? process.env.JOB_DIR
    : path.join(ROOT, "public/generated", process.env.JOB_DIR)
  : path.join(ROOT, "public/generated/job_caesar_full");
// Override style-kit via env: STYLE_KIT=style-kit-genghis.json ou chemin absolu
const STYLE_KIT_PATH = process.env.STYLE_KIT
  ? (path.isAbsolute(process.env.STYLE_KIT) ? process.env.STYLE_KIT : path.join(ROOT, process.env.STYLE_KIT))
  : path.join(ROOT, "style-kit.json");
const CONFIG_PATH = path.join(ROOT, "config/settings.json");
const DEFAULT_SCRIPT_PATH = path.join(__dirname, "script-medieval.txt");
// Ce run : avec voix off ElevenLabs, sans sous-titres brules
const SKIP_VOICE = process.argv.includes("--skip-voice");
const SKIP_SUBTITLES = true;   // pas de sous-titres dans ce type de video

const SCENE_PARSE_BATCH = 5;      // Claude — parse segments en parallele
const IMAGE_BATCH_SIZE = 30;      // WaveSpeed Silver : 60 concurrent, on garde marge
const CLIP_BATCH_SIZE = 30;       // idem video : 60 concurrent, marge de securite
const WPM = 120;
const TRANSITION_DUR = 0;
const FPS = 24;
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
// Montage = FULL VIDEO : chaque scene decoupee en clips 4-7s
// dont la somme = durée de la scène (aligne visuel/narration).
// Pas de Ken Burns, pas de particules.
// Variations de FRAMING pour l'image de base de chaque clip — change la composition
// (angle, focale, cadrage). Deux jeux selon hasMainCharacter.
// Priorite : environnement respire. Caesar est petit/en retrait/partiel dans la plupart
// des cadrages. Un seul close-up autorise pour un moment d'emphase.
const FRAMING_VARIANTS_CHAR = [
  "wide establishing shot, full environment dominating the frame, character small in the lower right",
  "wide environmental shot, character small on the left side, scene opening toward the right",
  "view from behind the character, character's back small in foreground, scene extending away into distance",
  "high angle looking down from above, character small, wide view of the whole room and its details",
  "character silhouetted against a large window or doorway, scene backlit, character small against the light",
  "wide three-quarter angle, character taking 25% of the frame on the right, environment filling the rest",
  "medium-wide shot, character half-visible at the edge, camera focused on the environment and props",
  "wide shot from across the room, character distant, foreground props partially framing the view",
  "low angle wide shot, character small standing in a large space, tall walls or columns above",
  "medium close-up (only one per scene) character centered, shoulders up, used for emotional emphasis",
];

const FRAMING_VARIANTS_ENV = [
  "wide establishing shot, full environment visible, symmetrical composition",
  "extreme close-up on a key detail in the scene, shallow depth of field",
  "low angle from ground level looking across the scene",
  "high angle looking down at the scene from above",
  "through a doorway or archway, framed partial view of the scene",
  "slight side angle with strong depth and perspective",
  "wide diagonal composition, dramatic lines leading into the scene",
  "tight medium framing, focus on a central object or prop",
  "distant view looking into the scene through a window or opening",
  "ground-level close to the floor, looking forward into the scene",
];

// Variations de MOUVEMENT CAMERA pour l'animation kling (apres image gen).
const CAMERA_VARIANTS = [
  "slow camera push-in, gentle zoom toward center",
  "slow camera pan from left to right across the scene",
  "gentle pull-back reveal, camera slowly drifts backward",
  "subtle camera tilt upward, soft parallax",
  "slight handheld drift, organic atmospheric motion",
  "slow orbit around the subject, smooth rotation",
];

/**
 * Decoupe une scene de duree D en clips de [CLIP_DUR_MIN, CLIP_DUR_MAX] secondes
 * dont la somme = D (pour rester aligne sur la narration).
 */
function splitSceneIntoClipDurations(D) {
  const safeD = Math.max(CLIP_DUR_MIN, Math.round(D));
  const nClips = Math.max(1, Math.ceil(safeD / CLIP_DUR_MAX));
  const base = Math.floor(safeD / nClips);
  const remainder = safeD - base * nClips;
  const out = [];
  for (let i = 0; i < nClips; i++) {
    let d = base + (i < remainder ? 1 : 0);
    if (d < CLIP_DUR_MIN) d = CLIP_DUR_MIN;
    if (d > CLIP_DUR_MAX) d = CLIP_DUR_MAX;
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

  const prompt = `Tu es directeur artistique / storyboardeur pour un short YouTube storytime historique
sur Jules Cesar enfant (Rome antique 94 BC).

ART DIRECTION (IMMUABLE — identique sur TOUTES les scenes):
- Style: 2D cartoon cel-shading "livre pour enfants" / Pixar storytime. PAS photorealiste, PAS 3D, PAS anime.
- Palette: warm amber, terracotta, marble white, cream, muted purple, dark chocolate hair.
- Outlines: bold black uniforme 3-5px, sur TOUT (persos, decors, props).
- Faces: tous les humains dans le cadre ont des visages RONDS, BLANCS, SANS RELIEF, avec juste
  2 yeux dot noirs, 2 lignes sourcils, 1 ligne bouche minimaliste. JAMAIS de visage realiste.
- Caesar: petit garcon 6 ans, visage rond blanc, cheveux bruns bowl-cut, tunique cream avec
  liseré gold/pourpre, sash sienna rouge en diagonale. Identite LOCKED sur toutes les scenes.

AVANT D'ECRIRE LE JSON, raisonne sur l'arc narratif:
- Identifie intro / tension / contraste / climax mental.
- Varie les shot types: WIDE establishing, MEDIUM interaction, CLOSE-UP emotion, EXTREME CLOSE-UP insert, METAPHOR pure.
- Decide quand Caesar est dans le cadre vs absent (env/metaphor).
- Continuite: memes lieux reutilises = memes references visuelles.

${fullScript ? `CONTEXTE NARRATIF COMPLET (l'ordre compte):

"""
${fullScript}
"""

` : ""}Pour CHAQUE segment ci-dessous, produis UN objet JSON avec la STRUCTURE NESTED suivante :

{
  "environment": {
    "locationId": "string snake_case (ex: domus_atrium, subura_street_night, upstairs_window, forum_sword_metaphor, prop_closeup_rings)",
    "settingType": "string court (ex: 'interior atrium', 'narrow night alley', 'symbolic forum plaza')",
    "timeOfDay": "morning / midday / afternoon / dusk / night / timeless",
    "weather": "clear / overcast / rainy / n/a",
    "lighting": "description specifique (ex: 'warm amber dawn light, long soft shadows', 'flickering torchlight, deep indigo ambient')"
  },
  "visual": {
    "shotType": "wide establishing / medium-wide / medium / close-up / extreme close-up insert / wide symbolic / POV window / over-the-shoulder",
    "focus": "ce sur quoi le plan attire l'oeil (ex: 'the boy observing Rome', 'the litter and its senators', 'the engraved plaque')",
    "composition": "arrangement spatial (ex: 'Caesar small lower-right, city spread across depth', 'split frame: boy right 30%, street below-left 70%')",
    "sceneDescription": "DENSE 50-100 mots: decor + 2-3 autres persos peuples avec traits + action concrete + props + lumiere. JAMAIS 'no characters present' (sauf si prop-closeup pur). PAS de Caesar ici (il est gere par character). PAS de mention du style (cartoon/cel-shading — direction locked globalement)."
  },
  "character": {
    "present": boolean,
    "expression": "court, filmable avec dot eyes + mouth line (si present). Ex: 'cold resolve, jaw set, eyes forward' / 'quiet wonder, eyebrows raised'. Vide si !present.",
    "placement": "OU et COMMENT Caesar est dans le cadre (si present). CRITIQUE pour POV shots. Ex: 'at upstairs window, leaning on sill, back half-turned, small right' / 'seated cross-legged foreground, back to camera'. Par defaut: Caesar PETIT, en retrait, partiellement visible — JAMAIS centre large sauf emphase emotion explicite. Vide si !present.",
    "pose": "posture corporelle statique (ex: 'still, balanced, hands at sides', 'flattened to wall, cautious'). Vide si !present."
  },
  "motion": {
    "environment": ["array de 1-3 mouvements dans le decor: 'smoke curls up from chimneys', 'crowd steps aside left and right', 'flame flickers', 'dust motes drift in sunbeam', 'litter moves right to left'"],
    "character": ["array de 0-2 micro-mouvements Caesar: 'head turns slightly following procession', 'small upward chin movement' — vide si !character.present"],
    "camera": {
      "type": "slow push-in / slow pull-back / lateral pan / static / subtle drift / nudge forward",
      "direction": "vers quoi (ex: 'toward the marble temples', 'onto the rings', 'down the alley corridor') — vide si static",
      "speed": "very slow / gentle / moderate / none-static"
    }
  },
  "generation": {
    "imagePrompt": "STRING dense directement injectable dans l'API image (wan-2.7): reprends visual.sceneDescription + environment.lighting + visual.composition + (si character.present) character.placement. NE PAS ajouter le style (cartoon cel-shading — injecte separement). NE PAS decrire Caesar (inject separement). Vise 60-120 mots concatenes en un prompt fluide.",
    "negativePrompt": "elements a bannir pour CETTE scene (ex: 'modern buildings, medieval armor, empty street, blurry crowd, photorealistic faces')"
  }
}

REGLES GLOBALES:
- character.present = FALSE pour : gros plans props purs, metaphores visuelles (epee/foule), etablissements larges vides.
- character.present = TRUE quand narration parle a la 1re personne ("you watch", "you feel", "you stand").
- JAMAIS "no characters present" dans sceneDescription — peuple avec 2-3 figurants meme si character.present=true.
- Continuite: memes locationId reutilises = meme decor.

Reponds UNIQUEMENT avec JSON strict, ARRAY "scenes" dans l'ordre des segments, meme nombre d'elements:
{ "scenes": [ { ...schema ci-dessus... }, ... ] }

- "locationId" (string, snake_case EN ANGLAIS) : IDENTIFIANT DU LIEU pour la coherence visuelle.
  Meme id = meme lieu general, MAIS chaque scene doit montrer un endroit/angle DIFFERENT de ce lieu.

  REGLES STRICTES:
  1. MAX 3-4 scenes consecutives partagent un locationId. Au-dela, force une nouvelle location
     meme si narrativement on est toujours au meme endroit (interpretation libre autorisee).
  2. Si N scenes partagent un id, CHACUNE doit montrer un COIN DIFFERENT du lieu:
     ex. domus_interior → scene A dans l'atrium, scene B cuisine, scene C couloir, scene D chambre,
     scene E devant l'autel familial. JAMAIS la meme compo deux fois.
  3. Pour les phrases METAPHORIQUES ou ABSTRAITES ("opens doors the way a sword parts a crowd",
     "name without power is noise", "you memorize every face"), INTERPRETE VISUELLEMENT avec un
     NOUVEAU lieu pour varier — genere une vraie scene d'epee/foule, ou un forum, ou une rue,
     PAS un intrieur domus par defaut.
  4. Varie les moments du jour (morning / noon / dusk / night) entre scenes du meme locationId
     pour casser la monotonie visuelle.

  Exemples d'ids: "domus_atrium", "domus_kitchen", "domus_study", "subura_street_day",
  "subura_street_dusk", "upstairs_window", "forum_crowd", "roman_alley", "cliff_rooftop_view",
  "senate_hall", "temple_exterior". Si une scene est un gros plan prop abstrait:
  "prop_closeup_scroll", "prop_closeup_plaque".

Reponds UNIQUEMENT en JSON strict, array "scenes" dans l'ORDRE des segments (meme nombre d'elements
que de segments en entree) :
{ "scenes": [
  { "sceneDescription": "...", "hasMainCharacter": true, "expression": "...", "locationId": "...", "characterPlacement": "...", "cameraMotion": "..." },
  ...
] }

SEGMENTS A ANNOTER (${sentences.length}) :
${numbered}`;

  // No fallback: en cas d'erreur on throw pour qu'on voie le vrai probleme.
  const result = await callClaudeRetry(apiKey, prompt, `Segments ${startIdx + 1}-${startIdx + sentences.length}/${totalSentences}`, 16384);

  // JSON parse robuste :
  //  1. Try parse direct
  //  2. Strip markdown fences (```json ... ``` n'importe ou dans la reponse)
  //  3. Fallback: extract premier bloc JSON qui commence par {"scenes":
  //  4. Fallback: outer {...}
  const extractJson = (raw) => {
    try { return JSON.parse(raw.trim()); } catch { }
    // Cherche un bloc markdown code fence
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch { }
    }
    // Cherche un objet JSON qui commence par {"scenes"
    const scenesMatch = raw.match(/\{\s*"scenes"\s*:[\s\S]*$/);
    if (scenesMatch) {
      // Match brace par brace pour trouver la fin
      let depth = 0, end = -1;
      for (let i = 0; i < scenesMatch[0].length; i++) {
        const c = scenesMatch[0][i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        try { return JSON.parse(scenesMatch[0].slice(0, end)); } catch { }
      }
    }
    // Dernier recours: greedy
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
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
      locationId: "generic_scene",
      settingType: "generic Roman scene",
      timeOfDay: "afternoon",
      weather: "clear",
      lighting: "warm amber ambient light",
    },
    visual: {
      shotType: "medium-wide",
      focus: "general scene",
      composition: "balanced, environment dominates",
      sceneDescription: "warm cartoon ancient Roman scene, clean composition, simple background with 2-3 figures in tunics",
    },
    character: {
      present: true,
      expression: "stoic and observant, eyes forward, mouth neutral",
      placement: "small in the lower right corner, observing quietly",
      pose: "still, hands at sides",
    },
    motion: {
      environment: ["subtle atmospheric drift"],
      character: [],
      camera: { type: "static", direction: "", speed: "none-static" },
    },
    generation: {
      imagePrompt: "warm cartoon ancient Roman scene, soft amber light, small Roman boy lower-right",
      negativePrompt: "photorealistic, modern objects, text, watermark",
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
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`, { stdio: "pipe" });
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
      timeline.push({ filePath: clip.clipPath, durationSeconds: clip.durationSeconds, sceneIndex: scene.index });
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

    // -an sur chaque clip : le provider peut renvoyer une piste audio silencieuse, on la drop
    const inputs = chunk.map((seg) => `-an -i "${seg.filePath}"`);

    const filters = chunk.map((seg, i) =>
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=${FPS},setsar=1,trim=duration=${seg.durationSeconds.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`,
    );

    if (chunk.length > 1 && TRANSITION_DUR > 0) {
      let prevLabel = "v0";
      let offset = chunk[0].durationSeconds - TRANSITION_DUR;
      for (let i = 1; i < chunk.length; i++) {
        const outLabel = i === chunk.length - 1 ? "outv" : `x${String(i).padStart(2, "0")}`;
        filters.push(`[${prevLabel}][v${i}]xfade=transition=fade:duration=${TRANSITION_DUR.toFixed(2)}:offset=${Math.max(0, offset).toFixed(2)}[${outLabel}]`);
        prevLabel = outLabel;
        if (i < chunk.length - 1) offset += chunk[i].durationSeconds - TRANSITION_DUR;
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
  console.log("=== MEDIEVAL PIPELINE — wan-2.7/image-edit + bytedance/seedance-v1-pro-fast/image-to-video ===\n");

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
  const PARSE_PROMPT_VERSION = "v2-nested-schema";
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
    const SENTENCES_PER_CALL = 15;
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

  // 4. Images via wan-2.7/image-edit — 1 image UNIQUE par clip
  //    Chaque scene decoupee en N clips → N images avec framing different,
  //    meme perso/style grace aux refs + seed + character_block.
  const clipPlan = []; // [{scene, ci, dur, framing, imgPath, clipPath, imgSceneKey}]
  for (const scene of allScenes) {
    const clipDurations = splitSceneIntoClipDurations(scene.durationSeconds);
    for (let ci = 0; ci < clipDurations.length; ci++) {
      const dur = clipDurations[ci];
      const framingPool = scene.hasMainCharacter ? FRAMING_VARIANTS_CHAR : FRAMING_VARIANTS_ENV;
      const framing = framingPool[ci % framingPool.length];
      const imgPath = path.join(imagesDir, `scene_${String(scene.index).padStart(3, "0")}_c${ci}.png`);
      const clipPath = path.join(clipsDir, `clip_${String(scene.index).padStart(3, "0")}_${ci}_${dur}s.mp4`);
      const imgSceneKey = `${scene.index}_c${ci}`;
      clipPlan.push({ scene, ci, dur, framing, imgPath, clipPath, imgSceneKey });
    }
  }

  console.log(`[4/5] Images (wan-2.7/image-edit) — ${clipPlan.length} images (1 par clip) sur ${allScenes.length} scenes`);
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
                sceneDesc += `. Caesar placement: ${t.scene.characterPlacement}`;
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
  const totalAnimS = allScenes.reduce((s, sc) => s + sc.durationSeconds, 0);
  console.log(`>>> Images generees dans ${imagesDir}`);
  console.log(`>>> Inspecte-les visuellement. Prochaine etape : ${clipPlan.length} clips seedance-v1-pro-fast (~${Math.round(totalAnimS)}s de video, COUTEUX).`);
  const go = await askConfirm(">>> Continuer vers generation des clips video ? (y/N) ");
  if (!go) {
    console.log("\nArret apres generation des images. Relance le script pour reprendre a l'etape clips.");
    return;
  }
  console.log("");

  // 5. I2V bytedance/seedance-v1-pro-fast/image-to-video — 1 clip par image (4-7s, sans son)
  console.log(`[5/5] Animation I2V bytedance/seedance-v1-pro-fast/image-to-video — ${clipPlan.length} clips sur ${allScenes.length} scenes, ~${Math.round(totalAnimS)}s`);
  const allClips = [];

  const clipTasks = [];
  for (const t of clipPlan) {
    const imgEntry = imageResults.get(t.imgSceneKey);
    if (!imgEntry) {
      console.warn(`  Pas d'image pour ${t.imgSceneKey} — clip ignore`);
      continue;
    }
    // trimDur = duree reelle a garder au montage.
    //   Priorite 1 : audioDurationSeconds (vraie duree MP3 ElevenLabs via ffprobe) = sync parfait
    //   Priorite 2 : narrationDurationSeconds (estimation WPM) si pas de voiceover per-scene
    //   Priorite 3 : t.dur (duree clip Kling) en dernier recours
    const narrDur = t.scene.audioDurationSeconds ?? t.scene.narrationDurationSeconds ?? t.dur;
    const trimDur = Math.max(0.5, Math.min(t.dur, narrDur));
    if (existsSync(t.clipPath) && statSync(t.clipPath).size > 10000) {
      allClips.push({ sceneIndex: t.scene.index, clipPath: t.clipPath, durationSeconds: trimDur, clipIndex: t.ci });
      continue;
    }
    // Prompt motion minimaliste + garde-fou "naturel" : evite que Kling rajoute du vent
    // exagere ou des mouvements dramatiques. Laisse le modele decider du reste a partir de l'image.
    const motionPrompt = "anime this frame";
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
          return { sceneIndex: t.scene.index, clipPath: r.clipPath, durationSeconds: t.trimDur, clipIndex: t.ci };
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
