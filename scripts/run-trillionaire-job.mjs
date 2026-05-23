#!/usr/bin/env node
/**
 * run-trillionaire-job.mjs — pipeline dedie storytime "POV : tu deviens
 *   le trillionaire le plus riche de l'histoire" (FR, marche fr).
 *
 *   - Narration : video-your trillionairefr.txt (1er arg CLI aussi accepte)
 *   - Images    : WaveSpeed wan-2.7/image-edit + style-kit-trillionaire.json
 *                 → coherence perso/style verrouillee par refs + seed.
 *                   Le perso est en AGE UNIQUE (35-40 ans) — pas d'evolution.
 *                   2 modes wardrobe (HOME CASUAL vs NEW WEALTH UNIFORM) selon scene.
 *   - I2V       : bytedance/seedance-v1-pro-fast/image-to-video (WaveSpeed), video-only
 *   - Voiceover : ElevenLabs voix narrateur (config/settings.json, default fr)
 *   - Montage   : FFmpeg concat clips, audio scene-aligne (no subs)
 *
 * Usage : node scripts/run-trillionaire-job.mjs ["path/to/script.txt"]
 *
 * Flags utiles (herites du pipeline) :
 *   --parse-only      stop apres le parsing Claude (review JSON)
 *   --script-only     export markdown lisible (review narration + timing)
 *   --style-pack      stop apres images-anchor + voix (review style + voix)
 *   --skip-images     reutilise les images deja generees
 *   --skip-voice      pas de voix off (montage video-only)
 *   --pilot N         cap strict a N secondes
 *   --limit N         max N scenes
 *   --yes / -y        auto-confirme la gate I2V (a utiliser avec prudence)
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
// JOB_DIR=job_trillionaire_v2 node scripts/run-trillionaire-job.mjs ...
const JOB_DIR = process.env.JOB_DIR
  ? path.isAbsolute(process.env.JOB_DIR)
    ? process.env.JOB_DIR
    : path.join(ROOT, "public/generated", process.env.JOB_DIR)
  : path.join(ROOT, "public/generated/job_trillionaire_full");
const STYLE_KIT_PATH = process.env.STYLE_KIT
  ? (path.isAbsolute(process.env.STYLE_KIT) ? process.env.STYLE_KIT : path.join(ROOT, process.env.STYLE_KIT))
  : path.join(ROOT, "style-kit-trillionaire.json");
const CONFIG_PATH = path.join(ROOT, "config/settings.json");
const DEFAULT_SCRIPT_PATH = path.join(ROOT, "video-your trillionairefr.txt");
const SKIP_VOICE = process.argv.includes("--skip-voice");
const SKIP_SUBTITLES = true;

const SCENE_PARSE_BATCH = 5;
const IMAGE_BATCH_SIZE = 30;
const CLIP_BATCH_SIZE = 30;
const WPM = 120;
const TRANSITION_DUR = 0;
const FPS = 24;

const PILOT_ARG = process.argv.find((a, i, arr) => (a === "--pilot" || a === "-p") && arr[i + 1]);
const PILOT_IDX = PILOT_ARG ? process.argv.indexOf(PILOT_ARG) + 1 : -1;
const MAX_DURATION_S = PILOT_IDX > 0 ? parseInt(process.argv[PILOT_IDX], 10) || 0 : 0;

const LIMIT_ARG = process.argv.find((a, i, arr) => (a === "--limit" || a === "-l") && arr[i + 1]);
const LIMIT_IDX = LIMIT_ARG ? process.argv.indexOf(LIMIT_ARG) + 1 : -1;
const MAX_SCENES = LIMIT_IDX > 0 ? parseInt(process.argv[LIMIT_IDX], 10) || 0 : 0;
const CLIP_DUR_MIN = 3;
const CLIP_DUR_MAX = 7;
const I2V_RESOLUTION = "720p";

// FRAMING — adapte au POV "tu" : le protagoniste est souvent vu DE DOS, en profil,
// ou tres petit dans des espaces vastes (le luxe l'ecrase). Un seul close-up par scene.
const FRAMING_VARIANTS_CHAR = [
  "wide environmental shot, character seen from behind, his back small in lower-third, vast architecture filling the frame ahead",
  "wide establishing shot, character tiny on the right, the empty luxurious environment dominating the left",
  "over-the-shoulder shot looking past the character at his glowing smartphone screen in his white mitten hand",
  "high angle from above, character small standing alone in the centre of a vast marble room",
  "character silhouetted against a tall window or panoramic glass facade, scene backlit, character small against the cold daylight",
  "long corridor perspective, character walking away from camera down a row of identical closed white doors",
  "wide three-quarter angle from behind, character taking 20% of the frame on the left, environment filling the rest",
  "medium-wide shot from across a vast room, character distant at a long dining table, foreground props framing the view",
  "low angle wide shot from floor level, character small standing in a tall marble entrance hall",
  "medium close-up (only one per scene) character in profile, head and shoulders, used for emotional emphasis",
];

const FRAMING_VARIANTS_ENV = [
  "wide establishing shot, full environment visible, symmetrical composition",
  "extreme close-up on a key prop (smartphone bank-balance screen, tap glass of water, Carrefour yogurt pot, wristwatch on a mitten), shallow depth of field",
  "low angle from ground level looking across the scene",
  "high angle looking down at the scene from above",
  "through a doorway or archway, framed partial view of the scene",
  "slight side angle with strong depth and perspective",
  "wide diagonal composition, dramatic lines leading into the scene",
  "tight medium framing, focus on a central object or prop",
  "distant view looking into the scene through a tall window",
  "ground-level close to the floor, looking forward into the scene",
];

// Mouvement camera kling — calme, contemplatif, comme la narration interieure.
const CAMERA_VARIANTS = [
  "very slow camera push-in, gentle zoom toward the centre",
  "very slow lateral pan from left to right across the scene",
  "gentle pull-back reveal, camera slowly drifts backward to expose the empty room",
  "subtle camera tilt upward, soft parallax",
  "slight static drift, almost still, contemplative",
  "very slow orbit around the subject, smooth rotation",
];

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
    const req = https.request(
      { hostname, path: urlPath, method: "POST", headers: { ...headers, connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`HTTP POST timeout ${timeoutMs}ms`)); });
    if (body) req.write(body);
    req.end();
  });
}

async function callClaude(apiKey, prompt, maxTokens = 4096) {
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
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          const dataLine = ev.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
              textOut += obj.delta.text;
            } else if (obj.type === "error") {
              reject(new Error(`Claude stream error: ${JSON.stringify(obj.error || obj).slice(0, 200)}`));
            }
          } catch { /* skip */ }
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
function splitIntoClipSegments(fullText) {
  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
  const durOf = (s) => (wordCount(s) / WPM) * 60;

  const sentences = fullText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

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

async function annotateSentenceBatch(apiKey, sentences, startIdx, totalSentences, fullScript = "") {
  const numbered = sentences.map((s, i) => `${startIdx + i + 1}. ${s}`).join("\n\n");

  const prompt = `Tu es directeur artistique / storyboardeur pour un long-format YouTube storytime
documentaire-fiction sur le marche fr : "POV — TU VIENS DE DEVENIR LE TRILLIONAIRE LE PLUS RICHE
DE L'HISTOIRE DE L'HUMANITE (mille milliards d'euros sur ton compte)". La narration est a la 2e
personne ("Tu viens de devenir...", "Tu te rends compte..."). Sujet : la solitude clinique du
trop-plein, comment l'argent extreme detruit la vie ordinaire en six mois. Setting :
contemporain (annees 2020+), monde reel francais et international.

LIEUX SPECIFIQUES qui apparaissent dans le script (re-utilise les memes locationId entre scenes
qui partagent un lieu — coherence visuelle critique) :
- appartement parisien modeste (kitchen avec frigo, table en bois, fenetre sur cour, magnet
  Carrefour) — c'est l'ANCIEN logement du protagoniste, scenes des premieres heures.
- propriete de Saint-Jean-Cap-Ferrat 12 hectares (allee de gravier bordee de cypres, haute
  muraille de pierre, portail en fer forge, piscine exterieure face a la Mediterranee, hall
  d'entree marbre, escalier sculpte, couloir de 15 portes blanches identiques fermees, salle
  de cinema 60 fauteuils crème, piscine interieure turquoise, cave a vins 1 300 bouteilles
  poussiereuses, bibliotheque cuir-relie 4 000 livres jamais ouverts, immense cuisine marbre
  blanc sous LED froide).
- cabinet d'avocats fiscalistes du XVIe arrondissement de Paris (boiserie noyer, table de
  conference polie, fenetre sur Avenue Foch, 3 avocats associes en costume sombre).
- Cafe de Flore (banquettes bordeaux, miroirs, rambardes laiton, paparazzi en silhouette
  derriere la vitre).
- Monoprix de l'ancien quartier (rayon yaourts, neons fluorescents, packs verts-menthe et
  rouges, une femme qui pleure devant le protagoniste).
- hangar prive du Bourget (jet prive blanc).
- cabine du jet prive (fauteuils cuir creme, hublots ronds, vue Alpes).
- restaurant prive de Geneve (salle boisee discrete, longue table pour 6, hautes bougies
  blanches, le vieux trillionaire heritier qui parle).
- couloir d'hopital pour enfants (murs vert pale, une mere assise).
- chambre principale de la propriete a 3h du matin (fenetres sol-au-plafond sur la mer, le
  protagoniste assis au bord du lit).
- studio de Belleville 14m² (kitchenette, fenetre sur cour interieure, bouilloire, lumiere
  ambre tungstene chaleureuse — UNIQUEMENT pour la scene flashback finale du jeune homme
  de 28 ans qui sourit en faisant chauffer son cafe).
- portail de la propriete vu de l'exterieur (foule de demandeurs, gendarmes, journalistes).
- bureau de cybersecurite de l'equipe ex-Qatar (ecrans noirs, lumiere bleue froide).

ART DIRECTION (IMMUABLE — identique sur TOUTES les scenes):
- Style: 2D cartoon cel-shading "livre pour enfants" / storytime YouTube. PAS photorealiste,
  PAS 3D, PAS anime, PAS manga screentones. Visuel doux mais palette froide et clinique.
- Palette: marbre blanc poli, noir mat profond (costume anthracite-gris du protagoniste lit
  presque noir), or champagne pale (accents subtils sur poignees, cadres, verres a vin —
  jamais ostentatoire), bleu nuit pluvieux (Paris pluie nocturne, ciel hivernal Geneve,
  hublot de jet sur les Alpes), gris-bleu hivernal (toits enneiges Geneve, mer Saint-Jean-
  Cap-Ferrat ciel couvert), ocre mediterraneen et terracotta (murs villa Côte d'Azur, cliffs
  coucher de soleil), olive-vert et cypres profond (haies et pelouse de la propriete), vert-
  menthe Monoprix et rouge-Carrefour (UNIQUEMENT dans la scene Monoprix yaourts et sur le
  petit pot Carrefour), bordeaux Cafe de Flore, cuir creme (jet, family office), ambre
  tungstene chaleureux (UNIQUEMENT pour le studio Belleville et les scenes de cuisine
  nocturne — contraste ironique triste avec le froid clinique), LED-blanc clinique froid
  (cuisine villa a 3h du matin, hopital, salle cybersecurite, bureau avocats), gris cendre
  pale (mur d'enceinte de la propriete, cour de justice).
- Outlines: bold black uniforme 3-5px, sur TOUT (persos, decors, costumes, props,
  smartphones, verres, jets, cypres, escaliers de marbre).
- Faces: TOUS les humains dans le cadre ont des visages RONDS, BLANCS, SANS RELIEF, juste
  2 yeux dot noirs + 2 lignes sourcils + 1 ligne bouche. JAMAIS de visage realiste, JAMAIS
  de skin tone, JAMAIS de nez/joues/dents. Pas d'exception.
- Protagoniste (perso central): identite LOCKED via style-kit. AGE UNIQUE 35-40 ans, PAS
  d'evolution. Cheveux noirs courts side-part discrets. Costume anthracite-gris simple
  (single-breasted, chemise blanche col ouvert, JAMAIS de cravate, JAMAIS de pochette,
  JAMAIS de fedora, JAMAIS de pinky ring, JAMAIS de cigare, JAMAIS de tatouage). Une seule
  montre noire mate au poignet droit (signature). 2 modes wardrobe, l'ATMOSPHERE de la scene
  decide :
    - HOME CASUAL (premieres heures du script "tu es chez toi", scenes de cuisine nocturne
      a 3h du matin a la propriete, tap-water glass, retours flashback) : t-shirt blanc
      uni OU sweat gris uni, jean indigo uni, sneakers blanches OU pieds nus chez lui.
    - NEW WEALTH UNIFORM (toutes les scenes a partir de "tu construis ton chateau" : la
      propriete, les avocats, la philanthropie, Geneve, jet, hopital, tribunaux, dîner
      proteges, family office...) : costume anthracite-gris single-breasted, chemise
      blanche col ouvert sans cravate, oxfords noirs.
- POV: la narration est en "tu" — le protagoniste est SOUVENT vu DE DOS, en PROFIL, ou
  TINY de loin, RAREMENT face camera. C'est un homme qui regarde sa propre vie de
  l'exterieur. Privilegie back-shots, over-the-shoulder, silhouette devant grande fenetre.

PROPS RECURRENTS (ancres narratives — utilise-les aussi souvent que possible) :
- smartphone moderne noir uni avec un ecran sobre noir-et-blanc affichant une longue file
  de chiffres (le solde du compte) — apparait dans la mitten du protagoniste ou en gros plan.
- verre d'eau du robinet en verre transparent uni — premiere heure (cuisine parisienne) +
  scene cuisine 3h du matin a la propriete.
- petit pot de yaourt blanc avec opercule fin, etiquette Carrefour — premiere heure dans le
  frigo + scene Monoprix.
- cheque en papier blanc plie net (donne a la femme qui pleure au Monoprix).
- agenda noir uni avec liste de rendez-vous — gros plan dans la scene finale ("ton agenda
  affiche deja trois rendez-vous avant midi").

AVANT D'ECRIRE LE JSON, raisonne sur l'arc narratif:
- Identifie le LIEU implicite ou explicite (premiere heure → appartement parisien ; "tu
  construis ton chateau" → propriete Cap-Ferrat ; "Cafe de Flore" → cafe ; "Monoprix" →
  rayon yaourts ; "Geneve" → restaurant prive ; "jet prive cette nuit-la" → cabine de jet ;
  "tu retournes te coucher" → chambre principale ; le DERNIER paragraphe (28 ans Belleville,
  matin) → studio Belleville).
- Identifie le mode wardrobe : HOME CASUAL pour les toutes premieres scenes (1ere heure,
  tap-water, frigo Carrefour) + scenes nocturnes a la propriete (cuisine 3h du matin, fixe
  le plafond) ; NEW WEALTH UNIFORM partout ailleurs des qu'il agit en trillionaire.
- Decide quand le protagoniste est dans le cadre vs absent (env / metaphor / prop close-up).
- Varie shot types: WIDE establishing (allee de cypres, hall de marbre, foule devant le
  portail), MEDIUM (banquette Cafe de Flore, table de conference avocats, cabine jet),
  CLOSE-UP visage de profil ou de dos (un seul par scene), EXTREME CLOSE-UP insert
  (smartphone solde, verre d'eau, pot Carrefour, cheque, agenda, montre noire sur la
  mitten), WIDE SYMBOLIC (Manhattan d'une fenetre de jet, Mediterranee depuis la chambre,
  cypres au crepuscule, fenetre Belleville chaleureuse au matin).
- Continuite: memes locationId reutilises = meme decor.
- DERNIER paragraphe (le jeune homme de 28 ans dans son studio Belleville qui sourit en
  faisant chauffer son cafe) : c'est un AUTRE personnage (pas le protagoniste), meme
  white-round-face style mais cheveux legerement plus messy, sweat gris, jean uni, une
  bouilloire et un smartphone dans les mains. Fenetre ouverte, lumiere ambre tungstene
  chaleureuse — c'est l'opposite de tout le reste du film. character.present=true mais
  ageInScene n'existe pas pour ce perso (mets 28 a titre indicatif si demande).

${fullScript ? `CONTEXTE NARRATIF COMPLET (l'ordre compte, les lieux changent au fil du script):

"""
${fullScript}
"""

` : ""}Pour CHAQUE segment ci-dessous, produis UN objet JSON avec la STRUCTURE NESTED suivante :

{
  "environment": {
    "locationId": "string snake_case EN ANGLAIS (ex: paris_apartment_kitchen, cap_ferrat_villa_marble_hall, cap_ferrat_villa_corridor_white_doors, cap_ferrat_villa_kitchen_3am, cap_ferrat_garden_cypress_driveway, paris_xvi_law_firm_office, cafe_de_flore_interior, monoprix_yogurt_aisle, le_bourget_private_hangar, private_jet_cabin_alps, geneva_private_restaurant, childrens_hospital_corridor, master_bedroom_3am_seafront, belleville_studio_kitchen_morning, property_gate_crowd_outside, prop_closeup_smartphone_balance, prop_closeup_carrefour_yogurt, prop_closeup_tap_water_glass, prop_closeup_black_wristwatch)",
    "settingType": "string court (ex: 'modest Parisian apartment kitchen with a single window onto a zinc-roof courtyard', 'sweeping marble entrance hall of a Saint-Jean-Cap-Ferrat villa', 'cinema-banquette corner of Cafe de Flore in Paris', 'fluorescent yogurt aisle in a small Monoprix supermarket', 'private cabin of a small business jet over the Alps', 'dim wood-panelled private dining room in Geneva', 'tiny 14-square-metre Belleville studio kitchen with sunlit open window')",
    "timeOfDay": "morning / midday / afternoon / dusk / night / 3am / timeless",
    "weather": "clear / overcast / rainy / snowing / n/a",
    "lighting": "description specifique (ex: 'cold flat LED-white panels above the vast marble kitchen at 3am, faces stay flat white', 'soft burgundy and brass interior glow of the Cafe de Flore at evening', 'fluorescent strip light above the mint-green and red yogurt packs', 'cool blue alpine daylight through small round portholes of a private jet cabin', 'warm golden Mediterranean dusk on cypress-lined gravel driveway', 'warm amber tungsten morning light in a tiny Belleville kitchen with the window open onto a courtyard')"
  },
  "visual": {
    "shotType": "wide establishing / medium-wide / medium / close-up / extreme close-up insert / wide symbolic / POV / over-the-shoulder / from behind / mirror reflection",
    "focus": "ce sur quoi le plan attire l'oeil (ex: 'the glowing smartphone screen in his white mitten hand showing a long row of digits', 'the lone tap-water glass on the marble counter at 3am', 'the small Carrefour yogurt pot alone on a shelf inside the open fridge', 'the corridor of fifteen identical closed white doors disappearing into perspective', 'a single tear-droplet on the crying woman's flat white face in the yogurt aisle')",
    "composition": "arrangement spatial (ex: 'protagonist tiny lower-third seen from behind, vast marble entrance hall and sweeping staircase dominating the upper two thirds', 'symmetric Geneva private dining room, the older Geneva billionaire centred far back at head of table, protagonist seen from behind in foreground occupying lower-right', 'split frame: rain-streaked panoramic window left, the dark Mediterranean below right')",
    "sceneDescription": "DENSE 50-100 mots: decor + autres persos (sœur de Tours, mere agee, meilleur ami, paparazzi, avocats fiscalistes XVIe, majordome anglais, chef Lyonnaise, operators ex-GIGN, femme du Monoprix, vieux trillionaire heritier de Geneve, banquiers du family office, agente immobiliere d'Aspen, executifs d'associations, directeur d'hopital, juges, voisins de Belleville, jeune homme de 28 ans final) avec traits visibles (cheveux/costume) + action concrete + props (smartphone solde, verre d'eau du robinet, pot Carrefour, cheque, agenda noir, montre noire au poignet droit) + lumiere. JAMAIS 'no characters present' (sauf prop-closeup pur). PAS de mention du protagoniste ici (gere via character + generation.imagePrompt). PAS de mention du style (cartoon cel-shading — locked globalement)."
  },
  "character": {
    "present": boolean,
    "wardrobeMode": "HOME_CASUAL / NEW_WEALTH_UNIFORM / OTHER (le jeune homme de 28 ans final). Quel mode appliquer dans cette scene precise.",
    "expression": "court, filmable avec dot eyes + mouth line. Ex: 'mouth flat, eyes blank, frozen' / 'jaw faintly tight, eyes lowered toward the phone' / 'mouth slightly open, eyes empty, hollow stare' / (jeune homme final) 'small calm smile, eyes soft'. Vide si !present.",
    "placement": "OU et COMMENT le protagoniste est dans le cadre. CRITIQUE: par DEFAUT il est SEEN FROM BEHIND ou IN PROFILE, petit, en retrait — la propriete / l'architecture l'ecrasent. Ex: 'tiny silhouette seen from behind walking down the marble corridor of identical closed doors, far back-centre' / 'seated alone at the very end of a vast dining table seen in profile from the side, candles between him and camera' / 'standing still before a panoramic window, his back fills lower third, dark Mediterranean below'. Centre frontal UNIQUEMENT pour les rares moments d'emphase (verdict, dîner Geneve, scene finale du portail). Vide si !present.",
    "pose": "posture corporelle (ex: 'standing still, shoulders slightly forward, mitten holding the smartphone close to chest', 'seated on the edge of the bed, both mittens flat on his knees, head turned toward the dark sea', 'walking slowly down the cypress driveway, mittens in pockets', '(jeune homme final) leaning casually against the open Belleville window, one mitten on the kettle handle, smiling faintly'). Vide si !present."
  },
  "motion": {
    "environment": ["array de 1-3 mouvements: 'rain falls vertically and bounces on the Parisian zinc rooftops outside the window', 'the smartphone screen flickers softly with the long row of digits', 'cypress branches sway gently in the Cap-Ferrat breeze', 'a single LED panel hums above the marble kitchen', 'a thin trail of espresso steam curls up from the Cafe de Flore cup', 'the open Belleville window lets in the courtyard breeze, the curtain shifts'"],
    "character": ["array de 0-2 micro-mouvements protagoniste: 'thumb flicks up on the phone screen', 'eyes shift to the closed fridge', 'glass of water lifts to the mouth', 'turn slightly toward the camera before back to the window', '(jeune homme final) sets the kettle down on the hob, smiles' — vide si !character.present"],
    "camera": {
      "type": "very slow push-in / very slow pull-back / lateral pan / static / subtle drift / slow tilt down / slow tilt up",
      "direction": "vers quoi (ex: 'toward the smartphone screen', 'down the marble corridor', 'up the cypress avenue toward the villa') — vide si static",
      "speed": "very slow / gentle / moderate / none-static"
    }
  },
  "generation": {
    "imagePrompt": "STRING dense directement injectable dans l'API image (wan-2.7) en ANGLAIS: reprends visual.sceneDescription + environment.lighting + visual.composition + (si character.present) une mention EXPLICITE du protagoniste, de son AGE UNIQUE (35-40 years old contemporary French man), de son MODE wardrobe (HOME CASUAL: white t-shirt or grey sweatshirt + indigo jeans + sneakers OR bare feet — OR NEW WEALTH UNIFORM: anthracite-grey single-breasted suit + white shirt no tie + black oxfords), de ses cheveux noirs courts side-part discrets, ET de la matte-black wristwatch on the right mitten. Exemples: 'A 35-40-year-old French man in a plain white t-shirt and indigo jeans, short jet-black side-part hair, matte-black wristwatch on the right mitten, standing barefoot at the kitchen counter of a modest Parisian apartment, looking down at a glowing smartphone screen in his white mitten hand showing a long row of digits, faint zinc-roof light through the small window, plain pure-white skin and mittens with NO tattoo or sleeve decoration' / 'A 35-40-year-old French man in an anthracite-grey single-breasted suit and white open-collar shirt without a tie, short jet-black side-part hair, matte-black wristwatch on the right mitten, seen tiny from behind walking down the cypress-lined gravel driveway of a Saint-Jean-Cap-Ferrat villa under a warm Mediterranean dusk, plain pure-white skin with NO tattoo' / 'A 28-year-old French man in a plain grey hoodie over a white t-shirt and indigo jeans, slightly messier short jet-black hair, leaning casually against the open window of a tiny Belleville studio kitchen at morning, one mitten on a kettle on the hob, the other holding a black smartphone, faint smile, warm amber tungsten morning light, courtyard outside, plain pure-white skin and mittens with NO tattoo or sleeve decoration'. NE PAS ajouter le style (cartoon cel-shading — injecte separement). NE PAS ajouter de cravate, fedora, scar, cigar, pinky ring, tattoo, gold chain, beard. Vise 80-140 mots concatenes en un prompt fluide.",
    "negativePrompt": "elements a bannir pour CETTE scene (ex: 'photorealistic, photo, real photograph, 3D render, realistic faces, anime style, mix of art styles, tie or bowtie on the protagonist, fedora or any hat, cigar, pinky ring, gold chain, scar on cheek, beard or moustache on the protagonist, slick-back pompadour hair, double-breasted suit, three-piece pinstripe suit, vintage 1980s setting, Japanese yakuza setting, kimono, dragon tattoo, tribal forearm pattern, irezumi, sleeve tattoo, mafia capo, sicilian olive grove, little italy red brick tenements, blood splatter, gore')"
  }
}

REGLES GLOBALES:
- character.present = FALSE pour : gros plans props purs (smartphone solde sur table, verre
  d'eau seul sur le marbre, pot Carrefour seul dans le frigo, cheque pose, agenda ouvert),
  metaphores symboliques (skyline depuis fenetre de jet, mer Mediterranee de nuit, foule
  devant le portail vu de loin sans figure principale identifiable, cypres au crepuscule),
  etablissements larges vides (allee de gravier vide, hall de marbre vide, couloir des 15
  portes vide).
- character.present = TRUE quand narration "Tu" implique sa presence concrete dans le moment.
- JAMAIS "no characters present" dans sceneDescription — peuple avec 1-3 figurants
  secondaires meme si character.present=true (sœur, majordome, avocats, paparazzi,
  banquiers, voisins, etc. selon contexte).
- JAMAIS de marqueur mafia/yakuza/Sicily/Tokyo/feudal/cigar/fedora/scar/pinky ring/tatouage
  sur AUCUN personnage. C'est le marche fr contemporain, sujet trillionaire. ZERO tatouage,
  ZERO ink, ZERO tribal pattern, ZERO sleeve decoration sur AUCUN personnage — peau et
  manches plain solid colour partout.
- IMAGE PROMPT DOIT mentionner explicitement: "35-40-year-old French man" (ou "28-year-old"
  pour le tout dernier perso final), le mode wardrobe (HOME CASUAL ou NEW WEALTH UNIFORM
  developpe), short jet-black side-part hair, matte-black wristwatch on the right mitten,
  plain pure-white skin and mittens with NO tattoo / NO sleeve decoration.
  C'est ce qui pilote la coherence d'identite.

LOCATION IDS:
- "locationId" snake_case EN ANGLAIS : IDENTIFIANT du lieu pour la coherence visuelle.
- MAX 3-4 scenes consecutives partagent un locationId. Au-dela, force une nouvelle location
  (interpretation libre — change d'angle, de coin, de moment de la journee).
- Si N scenes partagent un id, CHACUNE doit montrer un COIN DIFFERENT du lieu (ex:
  cap_ferrat_villa → scene A allee de cypres, B hall de marbre, C couloir des portes
  blanches, D cuisine LED 3h du matin, E chambre face a la mer). JAMAIS la meme compo
  deux fois.
- Pour les phrases METAPHORIQUES / abstraites ("avoir trop est un poison", "la dissonance
  tu la sentiras des milliers de fois"), INTERPRETE VISUELLEMENT avec un NOUVEAU lieu /
  prop closeup symbolique (verre d'eau qui tremble dans la mitten, smartphone qu'on pose
  ecran face contre marbre, billets qui sortent d'un guichet de banque, montre qui passe a
  3h du matin, allee de gravier vide).
- Varie moments de la journee (morning / noon / dusk / night / 3am) entre scenes du meme
  locationId.

Exemples d'ids utilisables:
  "paris_apartment_kitchen_morning", "paris_apartment_courtyard_window",
  "paris_apartment_bathroom_mirror", "paris_neighborhood_street_block_walk",
  "cap_ferrat_garden_cypress_driveway_dusk", "cap_ferrat_villa_marble_hall",
  "cap_ferrat_villa_corridor_white_doors", "cap_ferrat_villa_cinema_60_seats",
  "cap_ferrat_villa_indoor_pool_turquoise", "cap_ferrat_villa_wine_cellar_dusty",
  "cap_ferrat_villa_library_unread_books", "cap_ferrat_villa_kitchen_led_3am",
  "cap_ferrat_villa_master_bedroom_seafront_3am", "cap_ferrat_perimeter_wall_iron_gate",
  "cap_ferrat_property_gate_crowd_outside", "paris_xvi_law_firm_office",
  "cafe_de_flore_interior_burgundy", "cafe_de_flore_glass_paparazzi_outside",
  "monoprix_yogurt_aisle_fluorescent", "le_bourget_private_hangar",
  "private_jet_cabin_alps_porthole", "geneva_private_restaurant_six_seat_table",
  "childrens_hospital_corridor_pale_green", "paris_courthouse_steps",
  "paris_cybersecurity_room_blue_glow", "paris_family_office_cream_leather",
  "aspen_real_estate_office_brochure", "belleville_studio_kitchen_morning_amber".
Prop closeups: "prop_closeup_smartphone_balance", "prop_closeup_carrefour_yogurt_pot",
  "prop_closeup_tap_water_glass_marble", "prop_closeup_black_wristwatch_on_mitten",
  "prop_closeup_paper_cheque_in_mitten", "prop_closeup_black_agenda_three_meetings",
  "prop_closeup_champagne_flute_geneva", "prop_closeup_press_magazine_cover_14_pages".

Reponds UNIQUEMENT avec JSON strict, ARRAY "scenes" dans l'ordre des segments, meme nombre
d'elements (${sentences.length}):
{ "scenes": [ { ...schema ci-dessus... }, ... ] }

SEGMENTS A ANNOTER (${sentences.length}) :
${numbered}`;

  // 32K output : annotations riches mais sans marqueurs d'age multiples → token-budget OK.
  const result = await callClaudeRetry(apiKey, prompt, `Segments ${startIdx + 1}-${startIdx + sentences.length}/${totalSentences}`, 32768);

  const sanitize = (s) => s
    .replace(/,\s*""\s*(?=[,}\]])/g, "")
    .replace(/(?<=[{,])\s*""\s*(?=[,}\]])/g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(jsonrepair(s)); } catch { return null; }
  };
  const extractJson = (raw) => {
    const r = sanitize(raw.trim());
    let p = tryParse(r); if (p) return p;
    const fenceMatch = r.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      p = tryParse(sanitize(fenceMatch[1].trim())); if (p) return p;
    }
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
      locationId: "paris_apartment_kitchen_morning",
      settingType: "modest Parisian apartment kitchen with a single window onto a zinc-roof courtyard",
      timeOfDay: "morning",
      weather: "overcast",
      lighting: "soft pale Parisian morning light through a single window, faces stay flat white",
    },
    visual: {
      shotType: "wide establishing",
      focus: "the small kitchen counter with a single smartphone face-down",
      composition: "kitchen counter and window dominating the frame, character tiny in profile",
      sceneDescription: "modest Parisian apartment kitchen, basic refrigerator with a small Carrefour fridge magnet, a plain wooden table with one chair, a single window onto a zinc-roof courtyard, neutral cream walls, a kettle and a clear glass on the counter, a black smartphone face-down beside the glass",
    },
    character: {
      present: true,
      wardrobeMode: "HOME_CASUAL",
      expression: "mouth flat, eyes blank, frozen",
      placement: "tiny in profile at the right edge of the frame, kitchen window light catching his back",
      pose: "standing still, shoulders slightly forward, mitten resting on the counter beside the glass",
    },
    motion: {
      environment: ["soft daylight shifts gently through the courtyard window"],
      character: [],
      camera: { type: "very slow push-in", direction: "toward the smartphone on the counter", speed: "very slow" },
    },
    generation: {
      imagePrompt: "modest Parisian apartment kitchen with a basic refrigerator carrying a small Carrefour fridge magnet, a plain wooden table, a single window onto a zinc-roof courtyard, a clear tap-water glass and a black smartphone face-down on the counter, soft pale morning light, a 35-40-year-old French man in a plain white t-shirt and dark indigo jeans, short jet-black side-part hair, matte-black wristwatch on the right mitten, plain pure-white skin and mittens with NO tattoo or sleeve decoration, standing still in profile at the right edge of the frame, shoulders slightly forward, looking down at the counter",
      negativePrompt: "photorealistic, photo, real photograph, 3D render, realistic faces, anime, blood, gore, text overlays, watermark, tie on the protagonist, fedora, cigar, pinky ring, scar, beard, slick-back pompadour, three-piece suit, japanese yakuza setting, kimono, mafia capo, sicilian olive grove, tattoo, sleeve tattoo, tribal forearm pattern, irezumi",
    },
  };
}

function sentenceToScene(sentence, annotation, index) {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  const estimated = (words / WPM) * 60;
  const duration = Math.max(CLIP_DUR_MIN, Math.min(CLIP_DUR_MAX, Math.round(estimated)));
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

  const cameraMotionFlat = [
    motion.environment.join("; "),
    motion.character.length ? `character: ${motion.character.join(", ")}` : "",
    motion.camera.type && motion.camera.type !== "static"
      ? `camera: ${motion.camera.type}${motion.camera.direction ? " " + motion.camera.direction : ""} (${motion.camera.speed})`
      : "static camera",
  ].filter(Boolean).join(". ");

  return {
    environment: env,
    visual,
    character,
    motion,
    generation,
    narration: sentence,
    sceneDescription: visual.sceneDescription,
    hasMainCharacter: character.present !== false,
    expression: character.expression || "",
    wardrobeMode: character.wardrobeMode || "NEW_WEALTH_UNIFORM",
    locationId: env.locationId,
    characterPlacement: character.placement || "",
    cameraMotion: cameraMotionFlat,
    durationSeconds: duration,
    narrationDurationSeconds: estimated,
    index,
  };
}

// ===================== STEP 2: VOICEOVER =====================
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

function ffprobeDuration(p) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf-8" });
  return parseFloat(out.trim());
}

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
    await sleep(400);
  }
  return results;
}

function concatSceneAudios(sceneAudios, outputPath) {
  const concatFile = path.join(path.dirname(outputPath), "voiceover_scenes_concat.txt");
  writeFileSync(concatFile, sceneAudios.map((s) => `file '${path.resolve(s.audioPath)}'`).join("\n"));
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`, { stdio: "pipe" });
  try { unlinkSync(concatFile); } catch { }
}

// ===================== STEP 5: MONTAGE =====================
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
  const videoOnlyMode = !audioPath;
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

  if (!burnSubs) {
    execSync(`ffmpeg -y -i "${videoOnly}" -i "${trimmedAudio}" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "${outputPath}"`, { stdio: "pipe", maxBuffer: 50 * 1024 * 1024 });
    try { unlinkSync(videoOnly); } catch { }
    try { unlinkSync(trimmedAudio); } catch { }
    const size = statSync(outputPath).size;
    console.log(`  Video finale (audio, no subs): ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
    return;
  }

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
  console.log("=== TRILLIONAIRE PIPELINE — wan-2.7/image-edit + bytedance/seedance-v1-pro-fast/image-to-video ===\n");

  const scriptPath = process.argv[2] || DEFAULT_SCRIPT_PATH;
  if (!existsSync(scriptPath)) {
    console.error(`Script introuvable : ${scriptPath}`);
    console.error(`Pose ton script narration ici puis relance.`);
    process.exit(1);
  }

  const config = loadConfig();
  // Pas d'override voix : on utilise celle du settings.json (default fr).
  const styleKit = loadStyleKit(STYLE_KIT_PATH);
  console.log(`Style kit : seed=${styleKit.project_seed} hash=${styleKit._hash.slice(0, 8)} refs=${styleKit.style_refs.length}\n`);

  const imagesDir = path.join(JOB_DIR, "images");
  const clipsDir = path.join(JOB_DIR, "clips");
  const cachePath = path.join(JOB_DIR, "images_results.json");
  for (const d of [JOB_DIR, imagesDir, clipsDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  console.log(`[1/5] Chargement narration : ${scriptPath}`);
  const fullScript = readFileSync(scriptPath, "utf-8").trim();
  console.log(`  ${fullScript.split(/\s+/).length} mots\n`);

  const PARSE_PROMPT_VERSION = "v3-trillionaire-fr-no-tattoo-single-age";
  const parseFingerprint = (() => {
    const hasher = createHash("md5");
    hasher.update(fullScript);
    hasher.update(`wpm=${WPM}|min=${CLIP_DUR_MIN}|max=${CLIP_DUR_MAX}|prompt=${PARSE_PROMPT_VERSION}`);
    return hasher.digest("hex");
  })();

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

    const sentences = splitIntoClipSegments(fullScript);
    console.log(`  ${sentences.length} segments detectes (phrases + splits virgule)`);

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

  const audioPath = path.join(JOB_DIR, "voiceover.mp3");
  const voiceDir = path.join(JOB_DIR, "voiceover");
  let voiceover = null;
  if (SKIP_VOICE) {
    console.log("[3/5] Voiceover skip (SKIP_VOICE=true, montage video-only)\n");
  } else {
    console.log("[3/5] Voiceover per-scene (ElevenLabs)...");
    const sceneAudios = await generateVoiceoverPerScene(config, allScenes, voiceDir);
    if (sceneAudios) {
      for (const a of sceneAudios) {
        const sc = allScenes.find((s) => s.index === a.sceneIndex);
        if (sc) sc.audioDurationSeconds = a.durationSeconds;
      }
      concatSceneAudios(sceneAudios, audioPath);
      const totalDur = sceneAudios.reduce((s, a) => s + a.durationSeconds, 0);
      voiceover = { audioPath, durationSeconds: totalDur };
      console.log(`  Total voix: ${totalDur.toFixed(2)}s → ${audioPath}`);
    }
    console.log("");
  }

  const clipPlan = [];
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
  const imageResults = new Map();

  const locationAnchors = new Map();
  const anchorSceneIndex = new Map();
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
            // Priorite: generation.imagePrompt pre-construit par Claude.
            // Fallback: sceneDescription + characterPlacement + framing.
            let sceneDesc;
            if (t.scene.generation?.imagePrompt) {
              sceneDesc = t.scene.generation.imagePrompt;
              // Append placement si pas deja evoque (doublon pas grave).
              if (t.scene.hasMainCharacter && t.scene.characterPlacement) {
                sceneDesc += `. Protagonist placement: ${t.scene.characterPlacement}`;
              }
              // Wardrobe-mode reminder explicite — single-age, pas d'evolution.
              if (t.scene.hasMainCharacter && t.scene.wardrobeMode) {
                if (t.scene.wardrobeMode === "HOME_CASUAL") {
                  sceneDesc += `. The protagonist wears HOME CASUAL: plain white t-shirt OR plain grey sweatshirt, plain dark indigo jeans, plain white sneakers OR bare feet, NO tie, NO hat, NO suit. Short jet-black side-part hair, matte-black wristwatch on the right mitten.`;
                } else if (t.scene.wardrobeMode === "NEW_WEALTH_UNIFORM") {
                  sceneDesc += `. The protagonist wears the NEW WEALTH UNIFORM: anthracite-grey single-breasted suit, plain white shirt with top button undone (NO tie, NO bowtie, NO pocket square), polished plain black oxfords. Short jet-black side-part hair, matte-black wristwatch on the right mitten. NO fedora, NO cigar, NO pinky ring, NO scar, NO beard.`;
                }
              }
              // ABSOLUTE TATTOO BAN — applique sur TOUTES les scenes (proto + secondaires).
              // Defense en profondeur contre le boilerplate yakuza/irezumi qui peut leak via
              // l'anchor image ou un residu de prompt parent.
              sceneDesc += ` ABSOLUTE TATTOO BAN on every character in this image: NO tattoo, NO ink, NO tribal pattern, NO sleeve tattoo, NO neck or forearm or chest or back ink, NO body art, NO decorative motif on any visible skin or sleeve. All hands are plain pure-white mittens. All sleeves are plain solid-colour with no decorative pattern. NEVER any irezumi, yakuza tattoo, mafia tattoo, dragon tattoo, japanese tattoo, sailor tattoo, henna, or tribal forearm pattern.`;
            } else {
              const framingForImage = (t.scene.hasMainCharacter && t.scene.characterPlacement)
                ? t.scene.characterPlacement
                : t.framing;
              sceneDesc = `${t.scene.sceneDescription}, ${framingForImage}`;
            }
            const seedOffset = t.scene.index * 1000 + t.ci * 37 + Math.floor(Math.random() * 5000);
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
    await runBatch(dependentTasks, "dependents");
  }
  console.log("");

  if (process.argv.includes("--style-pack")) {
    const styleDir = path.join(JOB_DIR, "style-pack");
    if (!existsSync(styleDir)) mkdirSync(styleDir, { recursive: true });
    const anchorsOut = path.join(styleDir, "anchors");
    if (!existsSync(anchorsOut)) mkdirSync(anchorsOut, { recursive: true });
    for (const [loc, anchorPath] of locationAnchors.entries()) {
      if (!anchorPath || !existsSync(anchorPath)) continue;
      const dest = path.join(anchorsOut, `${loc}.png`);
      writeFileSync(dest, readFileSync(anchorPath));
    }
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

  console.log(`[5/5] Animation I2V bytedance/seedance-v1-pro-fast/image-to-video — ${clipPlan.length} clips sur ${allScenes.length} scenes, ~${Math.round(totalAnimS)}s`);
  const allClips = [];

  const clipTasks = [];
  for (const t of clipPlan) {
    const imgEntry = imageResults.get(t.imgSceneKey);
    if (!imgEntry) {
      console.warn(`  Pas d'image pour ${t.imgSceneKey} — clip ignore`);
      continue;
    }
    const narrDur = t.scene.audioDurationSeconds ?? t.scene.narrationDurationSeconds ?? t.dur;
    const trimDur = Math.max(0.5, Math.min(t.dur, narrDur));
    if (existsSync(t.clipPath) && statSync(t.clipPath).size > 10000) {
      allClips.push({ sceneIndex: t.scene.index, clipPath: t.clipPath, durationSeconds: trimDur, clipIndex: t.ci });
      continue;
    }
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
