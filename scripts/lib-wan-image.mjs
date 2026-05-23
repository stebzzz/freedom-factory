/**
 * lib-wan-image.mjs — generation d'images coherentes via WaveSpeed wan-2.5/text-to-image
 * + animation via kwaivgi/kling-v3.0-std/image-to-video (WaveSpeed).
 *
 * Cle de voute :
 *   - style-kit.json porte le perso (character_block), le style (style_block),
 *     les refs visuelles (style_refs) et le seed (project_seed).
 *   - generateSceneImage() injecte automatiquement character_block + style_block
 *     autour de la scene_description et envoie les refs + seed a l'API.
 *   - images_results.json cache chaque image avec { seed, style_kit_hash } pour
 *     permettre une regen ciblee quand le style kit bouge.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import https from "https";
import path from "path";

// ===================== CONFIG =====================
const WAVESPEED_HOST = "api.wavespeed.ai";
// Deux endpoints selon hasMainCharacter :
//   - true  : wan-2.7/image-edit avec la ref perso + prompt "NEW SCENE" pour forcer
//     l'identite/style du perso tout en generant un decor different
//   - false : wan-2.5/text-to-image pur (pas de ref, evite le leak composition)
const IMAGE_EDIT_PATH = "/api/v3/alibaba/wan-2.7/image-edit";
const IMAGE_T2I_PATH = "/api/v3/alibaba/wan-2.5/text-to-image";
const I2V_PATH = "/api/v3/bytedance/seedance-v1-pro-fast/image-to-video";
const RESULT_PATH = (reqId) => `/api/v3/predictions/${reqId}/result`;

const POLL_INTERVAL_MS = 2000;
const IMAGE_TIMEOUT_MS = 120_000;   // plan: 120s global timeout
const I2V_TIMEOUT_MS = 360_000;     // video = plus long

// ===================== UTILS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolveWaveSpeedKey(config) {
  const key = process.env.WAVESPEED_API_KEY || config?.wavespeedKey;
  if (!key) {
    throw new Error(
      "WAVESPEED_API_KEY manquante : definir la var d'env ou config.wavespeedKey dans config/settings.json",
    );
  }
  return key;
}

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: true, timeout: 300_000 });
    const req = https.request(
      { hostname, path: urlPath, method: "POST", agent, headers: { ...headers, connection: "keep-alive" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error("HTTP POST timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

function httpsGetJson(hostname, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function httpsDownload(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "FreedomFactory/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// ===================== STYLE KIT =====================
/**
 * style_refs peut contenir :
 *   - une URL HTTPS publique (ex. "https://raw.githubusercontent.com/.../anchor.png")
 *   - un chemin local relatif au repo racine (ex. "public/style-refs/anchor.jpeg")
 *     → auto-converti en data URI base64 avant envoi a l'API.
 * Les chemins locaux sont resolus par rapport au dossier contenant style-kit.json.
 * Le hash de cache integre le contenu des fichiers locaux : si tu modifies
 * l'image, le hash change → invalidation automatique.
 */
function resolveStyleRef(ref, baseDir) {
  if (/^https?:\/\//.test(ref)) {
    if (ref.includes("REPLACE_ME") || ref.includes("localhost") || ref.includes("127.0.0.1")) {
      throw new Error(`style-kit.json : URL invalide (placeholder ou localhost) : ${ref}`);
    }
    return { value: ref, bytes: null };
  }
  // Chemin local
  const abs = path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref);
  if (!existsSync(abs)) throw new Error(`style-kit.json : style_ref local introuvable : ${abs}`);
  const bytes = readFileSync(abs);
  const ext = path.extname(abs).toLowerCase().replace(".", "") || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return { value: `data:${mime};base64,${bytes.toString("base64")}`, bytes };
}

export function loadStyleKit(styleKitPath) {
  if (!existsSync(styleKitPath)) {
    throw new Error(`style-kit.json introuvable : ${styleKitPath}`);
  }
  const raw = readFileSync(styleKitPath, "utf-8");
  const kit = JSON.parse(raw);

  const required = ["project_seed", "style_refs", "character_block", "style_block", "negative_prompt"];
  for (const f of required) {
    if (kit[f] === undefined || kit[f] === null) throw new Error(`style-kit.json : champ ${f} manquant`);
  }
  if (!Array.isArray(kit.style_refs)) {
    throw new Error("style-kit.json : style_refs doit etre un array (peut etre vide pour mode text-to-image pur)");
  }

  const baseDir = path.dirname(path.resolve(styleKitPath));
  const resolved = kit.style_refs.length > 0
    ? kit.style_refs.map((r) => resolveStyleRef(r, baseDir))
    : [];

  // Hash = JSON brut + contenu des fichiers locaux referenced
  const hasher = createHash("md5").update(raw);
  for (const r of resolved) if (r.bytes) hasher.update(r.bytes);

  kit._hash = hasher.digest("hex");
  kit._path = styleKitPath;
  kit._resolved_refs = resolved.map((r) => r.value);
  return kit;
}

export function styleKitHash(styleKit) {
  return styleKit._hash;
}

// ===================== CACHE images_results.json =====================
export function loadImagesCache(cachePath) {
  if (!existsSync(cachePath)) return {};
  try { return JSON.parse(readFileSync(cachePath, "utf-8")); }
  catch { return {}; }
}

export function saveImagesCache(cachePath, cache) {
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Merge atomique d'UNE entry dans le cache : re-lit le fichier juste avant le write
 * pour fusionner les writes concurrents (sinon en mode parallel batch on perd des entries
 * — les call lisent un snapshot vide, mutent, et le dernier write ecrase les autres).
 * Reduit la fenetre de race au I/O read+write seul, vs read + appel API distant + write.
 */
export function mergeImagesCacheEntry(cachePath, sceneKey, entry) {
  const current = loadImagesCache(cachePath);
  current[sceneKey] = entry;
  writeFileSync(cachePath, JSON.stringify(current, null, 2));
}

/**
 * Verifie si l'image en cache est encore valide pour ce style kit.
 * (Le seed peut varier par clip — on ne l'utilise plus comme cle d'invalidation,
 *  c'est la sceneKey qui fait ce taf.)
 */
export function lookupCachedImage(cache, sceneKey, styleKit) {
  const entry = cache[sceneKey];
  if (!entry) return null;
  // if (entry.style_kit_hash !== styleKit._hash) return null; // DESACTIVE: on veut garder le cache meme si le style-kit a bougé
  if (!entry.imagePath || !existsSync(entry.imagePath)) return null;
  if (statSync(entry.imagePath).size < 5000) return null;
  return entry;
}

// ===================== IMAGE GEN (wan-2.5/text-to-image) =====================
/**
 * Genere une image de scene via wan-2.5/text-to-image.
 * Le prompt final :
 *   - hasMainCharacter = true  : character_block + scene_description + style_block
 *   - hasMainCharacter = false : scene_description + style_block
 *     (pour scenes sans le perso principal : gros plans prop, paysages, foule etc.
 *     On garde les style_refs pour ancrer le style visuel, mais on ne force pas
 *     le perso dans le cadre.)
 *
 * @param {string} sceneDescription  Decrit UNIQUEMENT ce qui change (decor/action/lumiere + autres persos)
 *                                   — NE PAS redecrire le perso principal ni le style general.
 * @param {boolean} hasMainCharacter Presence du perso principal dans la scene (defaut true).
 * @returns {Promise<{imagePath: string, prompt: string, seed: number, style_kit_hash: string}>}
 */
export async function generateSceneImage({ config, sceneDescription, styleKit, outputPath, sceneLabel = "", hasMainCharacter = true, expression = "", seedOffset = 0, additionalRefs = [] }) {
  const wsKey = resolveWaveSpeedKey(config);

  // Expression du perso principal (ex. "cold resolve, jaw set, eyes forward")
  const expressionBlock = hasMainCharacter && expression
    ? ` Caesar's face shows ${expression}.`
    : "";

  // seedOffset varie la composition entre clips d'une meme scene (sinon images trop proches).
  const effectiveSeed = styleKit.project_seed + seedOffset;

  // additionalRefs = array de chemins locaux (images) a ajouter aux references de l'API,
  // typiquement une "anchor image" deja generee pour la meme location → coherence visuelle
  // du decor entre scenes partageant un lieu. Convertit en data URI.
  const extraRefValues = [];
  for (const refPath of additionalRefs) {
    if (!refPath || !existsSync(refPath)) continue;
    const bytes = readFileSync(refPath);
    const ext = path.extname(refPath).toLowerCase().replace(".", "") || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    extraRefValues.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  const hasLocationRef = extraRefValues.length > 0;

  // Cartes d'identite et de style verrouillees (injectees en tete de chaque prompt).
  // Elles sont repetees a chaque scene pour empecher le drift visuel.
  const identityCard = styleKit.character_identity_card || "";
  const styleCard = styleKit.global_style_card || "";

  // T2I MODE: si le kit a style_refs vide ET pas de location ref → wan-2.5/text-to-image
  // Pas de ref image → wan ne peut pas copier de composition. Identite perso = description
  // texte seule (character_identity_card + character_block sont injectes en tete du prompt).
  // Seul mode qui marche pour des scenes vraiment varies entre elles.
  const useT2I = (!styleKit._resolved_refs || styleKit._resolved_refs.length === 0) && !hasLocationRef;
  // LEAN MODE: prompt court (~800 chars) au lieu du prompt complet (~7000 chars).
  // Identity card + character_block (qui pesent 5000 chars) sont remplaces par la ref image
  // (qui ancre l'identite visuelle). Le imagePrompt per-scene de Claude contient deja les
  // marqueurs cibles ("Yakuza at age X, [outfit/markers]") + decor + secondaires presents.
  // Wan voit la scene description en POSITION 1 → la respecte.
  const useLean = styleKit.lean_prompt === true && !useT2I;
  let endpointPath, body, fullPrompt;
  if (useLean) {
    // Le faceLockHint dependait avant de hasMainCharacter pour exempter le protagoniste
    // (sinon visage blanc ecrase l'identite de la ref). Avec proto: la ref drive le visage,
    // secondaires uniquement = ronds blancs. Sans proto: tout le monde = ronds blancs.
    const faceLockHint = hasMainCharacter
      ? `PROTAGONIST FACE: must match the FIRST reference image faithfully — preserve the exact head shape, hairstyle, beard/mustache (if present), eye details, mouth shape, and any other facial features as drawn in the ref. DO NOT replace the protagonist's face with a blank white circle. MANDATORY for ALL OTHER (secondary / background) human characters in the frame: perfectly circular 100% pure white (#FFFFFF) flat face with ONLY 2 small black dot eyes, thin straight black eyebrow strokes, and 1 short horizontal black mouth line. NO nose, NO cheeks, NO skin tone, NO realistic features for secondaries. Hands of secondary characters are pure white mitten silhouettes.`
      : `MANDATORY for EVERY human in the frame (no protagonist present): perfectly circular 100% pure white (#FFFFFF) flat face with ONLY 2 small black dot eyes, thin straight black eyebrow strokes, and 1 short horizontal black mouth line. NO nose, NO cheeks, NO skin tone, NO realistic facial features. Hands are pure white mitten silhouettes. Arms are either fully covered by long sleeves OR rendered as plain pure-white skin — NEVER any tattoo, tribal pattern, ink, body art, or decorative motif on the arms or forearms. Clothing is plain solid color with no decorative patterns on the sleeves.`;
    const refInstruction = hasLocationRef
      ? `Use the FIRST reference image ONLY for the main character's visual identity (face style, hair, outfit colors, OVERALL ART STYLE — 2D cel-shading, bold black outlines, flat colour palette, white round featureless faces). Use the SECOND reference ONLY to match the location's palette and lighting mood. DO NOT copy any reference's composition, framing, pose, or scene layout — invent a new composition strictly from the scene description below. CRITICAL: if any reference shows a tattoo, ink, tribal pattern, sleeve decoration, or body art on the skin or sleeves of any character, IGNORE it entirely — the new image must show plain pure-white skin and mittens, plain solid-colour sleeves with absolutely NO decorative motif on any visible skin or sleeve.`
      : `Use the reference image ONLY for the main character's visual identity (face style, hair, outfit, OVERALL ART STYLE — 2D cel-shading, bold black outlines, flat colour palette, white round featureless faces). DO NOT copy its composition, framing, pose, scene layout, or background — invent a new composition strictly from the scene description below. CRITICAL: if the reference shows a tattoo, ink, tribal pattern, sleeve decoration, or body art on the skin or sleeves of any character, IGNORE it entirely — the new image must show plain pure-white skin and mittens, plain solid-colour sleeves with absolutely NO decorative motif on any visible skin or sleeve.`;
    // Inject character_identity_card en tete quand le proto est present : sans ca, le mode
    // lean n'a aucune description textuelle des traits cibles → wan ne sait pas quoi preserver
    // au-dela de "faithful to ref". Avec la card, on rappelle bald/beard/outfit explicitement.
    const identityHeader = hasMainCharacter && identityCard ? `${identityCard}\n\n` : "";
    const styleLeadIn = `MANDATORY ART STYLE (overrides any photographic phrasing in the scene description below): this image must be a FLAT 2D CARTOON CEL-SHADED ILLUSTRATION drawn in a children's picture-book / storytime YouTube style with bold thick uniform black outlines and flat simple colours (max 2-3 tonal shades per object). NEVER photorealistic, NEVER a photograph, NEVER 3D render, NEVER realistic textures (wood grain, fabric weave, skin pores, glass reflections must all be drawn as flat cel-shaded shapes with bold outlines, not photo-real). Even prop close-ups, even environment shots, even shots without a character — EVERYTHING in the frame is the same hand-drawn cartoon style.\n\n`;
    fullPrompt =
      `${styleLeadIn}` +
      `${identityHeader}` +
      `${sceneDescription}\n\n` +
      `${faceLockHint}\n\n` +
      `${refInstruction}\n\n` +
      `${styleKit.style_block}`;
    body = JSON.stringify({
      images: [...styleKit._resolved_refs, ...extraRefValues],
      prompt: fullPrompt,
      negative_prompt: styleKit.negative_prompt,
      seed: effectiveSeed,
      size: "1920*1080",
    });
    endpointPath = IMAGE_EDIT_PATH;
  } else if (useT2I) {
    fullPrompt =
      (identityCard ? `${identityCard}\n\n` : "") +
      (styleCard ? `${styleCard}\n\n` : "") +
      (hasMainCharacter
        ? `NEW SCENE featuring the main character (identity locked by card above). The environment and scene composition must DOMINATE the frame; the character should be small, in retreat, or partially visible — NOT centered and large. ${styleKit.character_block}${expressionBlock} `
        : `ENVIRONMENT-ONLY scene WITHOUT the main character. ${styleKit.character_block.split(".").slice(1).join(".").trim()} `) +
      `Scene: ${sceneDescription}. ` +
      `${styleKit.style_block}`;
    body = JSON.stringify({
      prompt: fullPrompt,
      negative_prompt:
        `${styleKit.negative_prompt}, ` +
        (hasMainCharacter
          ? "character filling the frame, character centered and large, character close-up dominating, portrait composition"
          : "main character present in frame"),
      seed: effectiveSeed,
      size: "1920*1080",
    });
    endpointPath = IMAGE_T2I_PATH;
  } else if (hasMainCharacter) {
    const locationBlock = hasLocationRef
      ? ` The SECOND reference image shows AN EXAMPLE view of this location — use it ONLY to match the color palette, architectural style, wall/floor materials, and general lighting mood. The NEW image must show a COMPLETELY DIFFERENT view: different corner/spot of the same place, different camera angle, different focus subject, different composition. DO NOT copy the reference composition, layout, or character positions. Use the FIRST reference ONLY for the main character's visual identity (face shape, hair, outfit colors and patterns) and the overall art style (cel-shading, outline thickness, palette) — DO NOT copy its composition, framing, character pose, scene layout, background details, or camera angle.`
      : ` STRICT: Use the reference image ONLY for the main character's visual identity (face, hair, outfit) and the art style (cel-shading, outlines, palette). DO NOT copy its composition, framing, pose, scene layout, background, or camera angle. Each new image must invent its OWN composition strictly based on the scene description below — different setting details, different framing, different character placement, different camera angle.`;

    // Ordre: identity card → style card → scene-specific blocks → scene desc
    fullPrompt =
      (identityCard ? `${identityCard}\n\n` : "") +
      (styleCard ? `${styleCard}\n\n` : "") +
      `NEW SCENE featuring Caesar (identity locked by card above).${locationBlock} ` +
      `The environment and scene composition must DOMINATE the frame; the character should be small, in retreat, or partially visible — NOT centered and large. ` +
      `${styleKit.character_block}${expressionBlock} ` +
      `Scene: ${sceneDescription}. ` +
      `${styleKit.style_block}`;

    body = JSON.stringify({
      images: [...styleKit._resolved_refs, ...extraRefValues],
      prompt: fullPrompt,
      negative_prompt:
        `${styleKit.negative_prompt}, ` +
        (hasLocationRef ? "" : "same background as reference, reference image background, reference composition, kitchen, hanging pots, fireplace, roast chicken, bread on table, ") +
        `character filling the frame, character centered and large, character close-up dominating, portrait composition`,
      seed: effectiveSeed,
      size: "1920*1080",
    });
    endpointPath = IMAGE_EDIT_PATH;
  } else {
    // Scene env (sans perso principal) — on GARDE la ref character_anchor comme
    // ancre de STYLE (sinon le modele part en realiste/3D sans l'identite cartoon).
    // On dit explicitement au modele : ref = style UNIQUEMENT, pas d'ajout de Caesar.
    const locationBlockEnv = hasLocationRef
      ? ` The SECOND reference shows the same location — match its palette and architecture, DIFFERENT angle/composition.`
      : "";
    fullPrompt =
      (styleCard ? `${styleCard}\n\n` : "") +
      `ENVIRONMENT-ONLY scene WITHOUT Caesar (no round-white-faced boy in frame). ` +
      `Use the FIRST reference image ONLY as a strict ART STYLE anchor: same 2D cel-shading look, same bold thick black outlines, same flat color palette, and critically the SAME white-round-featureless-face treatment applied to ALL human figures present (women, men, elderly, senators, soldiers, servants — all must have pure white round faces with only tiny dot eyes, thin eyebrow lines, minimal mouth). DO NOT add Caesar himself.${locationBlockEnv} ` +
      `${styleKit.character_block.split(".").slice(1).join(".").trim()} ` +
      `Scene: ${sceneDescription}. ` +
      `${styleKit.style_block}`;
    body = JSON.stringify({
      images: [...styleKit._resolved_refs, ...extraRefValues],
      prompt: fullPrompt,
      negative_prompt: `${styleKit.negative_prompt}, main character present, Caesar visible in frame, boy in cream tunic with purple trim and red sash`,
      seed: effectiveSeed,
      size: "1920*1080",
    });
    endpointPath = IMAGE_EDIT_PATH;
  }

  const submitRes = await httpsPost(WAVESPEED_HOST, endpointPath, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${wsKey}`,
    "content-length": Buffer.byteLength(body).toString(),
  }, body);

  if (submitRes.status >= 400) {
    throw new Error(`wan-2.5/text-to-image submit ${submitRes.status}: ${submitRes.body.toString().slice(0, 300)}`);
  }

  const submitData = JSON.parse(submitRes.body.toString());
  const requestId = submitData.data?.id;
  if (!requestId) {
    throw new Error(`wan-2.5/text-to-image : pas d'id ${sceneLabel} — ${JSON.stringify(submitData).slice(0, 200)}`);
  }

  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await httpsGetJson(WAVESPEED_HOST, RESULT_PATH(requestId), {
      Authorization: `Bearer ${wsKey}`,
    });
    const data = JSON.parse(res.body.toString());
    const inner = data.data || data;

    if (inner.status === "completed") {
      const imageUrl = inner.outputs?.[0];
      if (!imageUrl) throw new Error(`wan-2.5/text-to-image : pas d'URL sortie ${sceneLabel}`);
      const imgBuf = await httpsDownload(imageUrl);
      writeFileSync(outputPath, imgBuf);
      return {
        imagePath: outputPath,
        prompt: fullPrompt,
        seed: styleKit.project_seed,
        style_kit_hash: styleKit._hash,
      };
    }
    if (inner.status === "failed") {
      throw new Error(`wan-2.5/text-to-image failed ${sceneLabel}: ${inner.error || "unknown"}`);
    }
  }
  throw new Error(`wan-2.5/text-to-image timeout ${sceneLabel} (${IMAGE_TIMEOUT_MS / 1000}s)`);
}

/**
 * Version retry (3 tentatives) autour de generateSceneImage.
 */
export async function generateSceneImageWithRetry(args) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await generateSceneImage(args); }
    catch (e) {
      lastErr = e;
      if (attempt < 3) {
        console.warn(`  [image-edit] ${args.sceneLabel || ""} retry ${attempt}/3: ${e.message.slice(0, 120)}`);
        await sleep(attempt * 2000);
      }
    }
  }
  throw lastErr;
}

// ===================== I2V (bytedance/seedance-v1-pro-fast/image-to-video via WaveSpeed) =====================
/**
 * Anime une image (fichier local) via bytedance/seedance-v1-pro-fast/image-to-video.
 * L'image est envoyee en base64 data URI (WaveSpeed l'accepte, contrairement
 * a l'API Kling directe qui exige du base64 brut).
 * Les args `resolution` et `seed` sont acceptes pour compat mais non utilises
 * (kling-v3.0-std ne les supporte pas sur WaveSpeed).
 */
export async function generateI2VClip({ config, imagePath, motionPrompt, outputPath, durationSec = 5, clipLabel = "" }) {
  const wsKey = resolveWaveSpeedKey(config);
  if (!existsSync(imagePath)) throw new Error(`Image introuvable: ${imagePath}`);

  const imageBuffer = readFileSync(imagePath);
  const dataUri = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  const body = JSON.stringify({
    image: dataUri,
    prompt: motionPrompt
  });

  const submitRes = await httpsPost(WAVESPEED_HOST, I2V_PATH, {
    "Content-Type": "application/json",
    Authorization: `Bearer ${wsKey}`,
    "content-length": Buffer.byteLength(body).toString(),
  }, body);

  if (submitRes.status >= 400) {
    throw new Error(`wan i2v submit ${submitRes.status}: ${submitRes.body.toString().slice(0, 300)}`);
  }

  const submitData = JSON.parse(submitRes.body.toString());
  const requestId = submitData.data?.id;
  if (!requestId) throw new Error(`wan i2v: pas d'id ${clipLabel} — ${JSON.stringify(submitData).slice(0, 200)}`);

  const deadline = Date.now() + I2V_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await httpsGetJson(WAVESPEED_HOST, RESULT_PATH(requestId), {
      Authorization: `Bearer ${wsKey}`,
    });
    const data = JSON.parse(res.body.toString());
    const inner = data.data || data;

    if (inner.status === "completed") {
      const videoUrl = inner.outputs?.[0];
      if (!videoUrl) throw new Error(`wan i2v: pas d'URL video ${clipLabel}`);
      const vidBuf = await httpsDownload(videoUrl);
      writeFileSync(outputPath, vidBuf);
      return { clipPath: outputPath, durationSeconds: durationSec };
    }
    if (inner.status === "failed") {
      throw new Error(`wan i2v failed ${clipLabel}: ${inner.error || "unknown"}`);
    }
  }
  throw new Error(`wan i2v timeout ${clipLabel}`);
}

export async function generateI2VClipWithRetry(args) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await generateI2VClip(args); }
    catch (e) {
      lastErr = e;
      if (attempt < 3) {
        console.warn(`  [i2v] ${args.clipLabel || ""} retry ${attempt}/3: ${e.message.slice(0, 120)}`);
        await sleep(attempt * 3000);
      }
    }
  }
  throw lastErr;
}

// ===================== HELPER : generate or reuse via cache =====================
/**
 * Cycle complet : cache hit → reuse ; miss → generate + update cache.
 * sceneKey = identifiant stable de la scene (ex. scene index en string).
 */
export async function generateSceneImageCached({ config, sceneKey, sceneDescription, styleKit, outputPath, cachePath, hasMainCharacter = true, expression = "", seedOffset = 0, additionalRefs = [] }) {
  const cache = loadImagesCache(cachePath);
  const hit = lookupCachedImage(cache, sceneKey, styleKit);
  if (hit) {
    return { ...hit, fromCache: true };
  }

  const result = await generateSceneImageWithRetry({
    config,
    sceneDescription,
    styleKit,
    outputPath,
    sceneLabel: sceneKey,
    hasMainCharacter,
    expression,
    seedOffset,
    additionalRefs,
  });

  const entry = {
    sceneDescription,
    hasMainCharacter,
    expression,
    imagePath: path.resolve(result.imagePath),
    prompt: result.prompt,
    seed: result.seed,
    style_kit_hash: result.style_kit_hash,
    generatedAt: new Date().toISOString(),
  };
  mergeImagesCacheEntry(cachePath, sceneKey, entry);
  return { ...result, fromCache: false };
}
