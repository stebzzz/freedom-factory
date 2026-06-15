import { ScriptResult, ScriptScene } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";
import { ChannelPreset, getPresetOrDefault } from "@/lib/presets/channel-presets";
import { callClaudeRetry, type ClaudeMessage } from "./claude-wrapper-client";

// ===================================================================
// All Claude calls route through the VPS wrapper (lib/api/claude-wrapper-client).
// `maxTokens` is ignored (handled server-side). The model id IS honoured: the
// wrapper client maps it to opus/sonnet/haiku.
// SPLIT: la génération de script narratif suit scriptModel (Opus pour la qualité),
// mais le découpage 2s / image-prompts / parsing tourne TOUJOURS sur Sonnet — Opus
// sur ces gros prompts (128KB) timeoutait sur le wrapper et faisait planter les jobs.
// ===================================================================

// Modèle pour la GÉNÉRATION DE SCRIPT narratif (+ réécriture concurrent).
function getModelId(config: { scriptModel: string }): string {
  return config.scriptModel === "claude-opus-4-6" ? "claude-opus-4-6" : "claude-sonnet-4-6";
}

// Modèle pour le découpage 2s / image-prompts / parsing — toujours Sonnet (rapide, pas de timeout).
const PROMPT_MODEL = "claude-sonnet-4-6";

// ===================================================================
// PUBLIC: generateScript — NO MOCK, throws on error
// ===================================================================
export async function generateScript(
  title: string,
  niche: string,
  brief: string,
  durationMinutes: number,
  voix: string,
  presetId?: string,
): Promise<ScriptResult> {
  const config = await getConfig();
  const preset = getPresetOrDefault(presetId);

  console.log("[Claude] Generation script reelle — PAS de mock");

  if (durationMinutes > 15) {
    return generateLongScript(title, niche, brief, durationMinutes, voix, preset);
  }

  return generateShortScript(title, niche, brief, durationMinutes, voix, preset);
}

// -------------------------------------------------------------------
// Short script
// -------------------------------------------------------------------
async function generateShortScript(
  title: string,
  niche: string,
  brief: string,
  durationMinutes: number,
  voix: string,
  preset: ChannelPreset,
): Promise<ScriptResult> {
  const config = await getConfig();
  const modelId = getModelId(config);

  const targetWords = durationMinutes * preset.script.wordsPerMinute;
  const numScenes = Math.max(5, Math.round(durationMinutes * preset.script.scenesPerMinute));
  const [minDur, maxDur] = preset.script.sceneDurationRange;

  const scriptPrompt = `Tu es un scriptwriter expert pour des videos YouTube faceless dans la niche "${niche}".

Ecris un script de ~${targetWords} mots pour une video intitulee "${title}".
Duree cible : ${durationMinutes} minutes.
Voix : ${voix.includes("fr") ? "Francais" : "Anglais"}, ton ${voix.includes("male") ? "masculin narratif" : "feminin informatif"}.
${brief ? `Brief additionnel : ${brief}` : ""}

${preset.script.claudeStylePrompt}

Vise environ ${numScenes} scenes de ${minDur} a ${maxDur} secondes chacune.

Pour chaque scene, fournis :
1. narration : le texte de narration
2. imagePrompt : un prompt EN ANGLAIS, hyper-detaille et cinematique pour GenAIPro Veo (16:9, 8K). Chaque image doit etre VISUELLEMENT DISTINCTE.
3. durationSeconds : duree en secondes (${minDur}-${maxDur}s)

Reponds en JSON strictement dans ce format :
{
  "scenes": [
    {
      "index": 0,
      "narration": "Texte de narration...",
      "imagePrompt": "Cinematic shot of..., 8k, photorealistic, 16:9",
      "durationSeconds": ${Math.round((minDur + maxDur) / 2)}
    }
  ]
}`;

  const response = await callClaudeRetry(modelId, 8192, [{ role: "user", content: scriptPrompt }], "Claude Script");
  return parseResponse(response, durationMinutes, numScenes);
}

// -------------------------------------------------------------------
// Long script — chunked
// -------------------------------------------------------------------
async function generateLongScript(
  title: string,
  niche: string,
  brief: string,
  durationMinutes: number,
  _voix: string,
  preset: ChannelPreset,
): Promise<ScriptResult> {
  const config = await getConfig();
  const modelId = getModelId(config);

  // Pour les très longues vidéos (>60min), chapitres plus courts pour rester dans les limites token
  const chapterTarget = durationMinutes > 60 ? 5 : 10; // 5min par chapitre pour 2h+
  const numChapters = Math.max(3, Math.ceil(durationMinutes / chapterTarget));
  const chapterDuration = Math.round(durationMinutes / numChapters);

  console.log(`[Claude] Script long: ${durationMinutes}min → ${numChapters} chapitres de ~${chapterDuration}min`);

  const outlineResponse = await callClaudeRetry(modelId, 2048, [{
    role: "user",
    content: `Tu dois creer un plan detaille pour une video YouTube de ${durationMinutes} minutes intitulee "${title}" dans la niche "${niche}".
${brief ? `Brief : ${brief}` : ""}

Divise en EXACTEMENT ${numChapters} chapitres de ~${chapterDuration} minutes chacun.

Reponds en JSON :
{
  "chapters": [
    { "title": "Titre du chapitre", "durationMinutes": ${chapterDuration}, "keyPoints": ["point1", "point2", "point3"] }
  ]
}`,
  }], "Claude Outline");

  const outlineText = outlineResponse.content[0]?.text || "";
  const outlineJson = outlineText.match(/\{[\s\S]*\}/);
  if (!outlineJson) throw new Error("Claude: pas d'outline JSON valide");

  const outline = JSON.parse(outlineJson[0]);
  const chapters = outline.chapters as Array<{ title: string; durationMinutes: number; keyPoints: string[] }>;

  console.log(`[Claude] Outline: ${chapters.map((c) => c.title).join(" → ")}`);

  const allScenes: ScriptScene[] = [];
  const [minDur, maxDur] = preset.script.sceneDurationRange;

  // Paralléliser par batches de 3 chapitres max
  // L'outline fournit assez de contexte pour que chaque chapitre se tienne sans dépendre du précédent
  const BATCH_SIZE = 3;
  let globalSceneIndex = 0;

  for (let batchStart = 0; batchStart < chapters.length; batchStart += BATCH_SIZE) {
    const batch = chapters.slice(batchStart, batchStart + BATCH_SIZE);
    const lastNarration = allScenes.length > 0 ? allScenes[allScenes.length - 1].narration : "";

    console.log(`[Claude] Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(chapters.length / BATCH_SIZE)} — chapitres ${batchStart + 1}-${batchStart + batch.length}`);

    const promises = batch.map((chapter, batchIdx) => {
      const ci = batchStart + batchIdx;
      const chapDur = chapter.durationMinutes || chapterDuration;
      const numScenes = Math.max(3, Math.round(chapDur * preset.script.scenesPerMinute));
      const targetWords = chapDur * preset.script.wordsPerMinute;

      // Contexte narratif : outline complet + hint sur le chapitre précédent pour le premier du batch
      const prevChapterTitle = ci > 0 ? chapters[ci - 1].title : "";
      const hint = batchIdx === 0 && lastNarration
        ? `\nLe chapitre precedent ("${prevChapterTitle}") se terminait par : "${lastNarration.slice(-150)}"\nAssure la continuite narrative.`
        : batchIdx > 0
          ? `\nLe chapitre precedent s'intitulait "${chapters[ci - 1].title}" — assure la continuite narrative.`
          : "";

      const outlineContext = chapters.map((c, i) => `${i + 1}. ${c.title}`).join("\n");

      return callClaudeRetry(modelId, 8192, [{
        role: "user",
        content: `Tu ecris le CHAPITRE ${ci + 1}/${chapters.length} d'une video YouTube de ${durationMinutes} minutes intitulee "${title}" (niche: ${niche}).

Plan complet de la video :
${outlineContext}

Ce chapitre s'intitule "${chapter.title}" et dure ~${chapDur} minutes (~${targetWords} mots).
Points cles a couvrir : ${chapter.keyPoints.join(", ")}.
${hint}

${preset.script.claudeStylePrompt}

Genere ~${numScenes} scenes de ${minDur} a ${maxDur} secondes.

Reponds en JSON :
{
  "scenes": [
    {
      "index": 0,
      "narration": "...",
      "imagePrompt": "Cinematic..., 8k, photorealistic, 16:9",
      "durationSeconds": ${Math.round((minDur + maxDur) / 2)}
    }
  ]
}`,
      }], `Claude Ch.${ci + 1}`);
    });

    const responses = await Promise.all(promises);

    // Réindexer les scènes dans l'ordre
    for (let batchIdx = 0; batchIdx < responses.length; batchIdx++) {
      const ci = batchStart + batchIdx;
      const chapDur = chapters[ci].durationMinutes || chapterDuration;
      const numScenes = Math.max(3, Math.round(chapDur * preset.script.scenesPerMinute));
      const scenes = parseChapterScenes(responses[batchIdx], globalSceneIndex, chapDur, numScenes);
      globalSceneIndex += scenes.length;
      allScenes.push(...scenes);
    }

    // Petit délai entre batches pour ne pas rate-limit
    if (batchStart + BATCH_SIZE < chapters.length) await new Promise((r) => setTimeout(r, 1000));
  }

  if (allScenes.length === 0) {
    throw new Error("Claude: aucune scene generee pour le script long");
  }

  const fullScript = allScenes.map((s) => s.narration).join("\n\n");
  const wordCount = fullScript.split(/\s+/).length;
  console.log(`[Claude] Script long: ${wordCount} mots, ${allScenes.length} scenes`);
  return { fullScript, scenes: allScenes, wordCount };
}

// -------------------------------------------------------------------
// Parse helpers
// -------------------------------------------------------------------
function parseResponse(response: ClaudeMessage, durationMinutes: number, fallbackNum: number): ScriptResult {
  const text = response.content[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude n'a pas retourne de JSON valide");

  const parsed = JSON.parse(jsonMatch[0]);
  const scenes: ScriptScene[] = parsed.scenes.map((s: ScriptScene, i: number) => ({
    index: i,
    narration: s.narration,
    imagePrompt: s.imagePrompt,
    durationSeconds: s.durationSeconds || Math.round((durationMinutes * 60) / fallbackNum),
  }));

  const fullScript = scenes.map((s) => s.narration).join("\n\n");
  const wordCount = fullScript.split(/\s+/).length;
  console.log(`[Claude] Script: ${wordCount} mots, ${scenes.length} scenes`);
  return { fullScript, scenes, wordCount };
}

function parseChapterScenes(response: ClaudeMessage, startIndex: number, chapDur: number, fallbackNum: number): ScriptScene[] {
  const text = response.content[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.scenes.map((s: ScriptScene, i: number) => ({
      index: startIndex + i,
      narration: s.narration,
      imagePrompt: s.imagePrompt,
      durationSeconds: s.durationSeconds || Math.round((chapDur * 60) / fallbackNum),
    }));
  } catch {
    return [];
  }
}

// ===================================================================
// PUBLIC: parseCustomScript — NO MOCK, throws on error
// ===================================================================
export async function parseCustomScript(
  rawText: string,
  title: string,
  niche: string,
  durationMinutes: number,
  presetId?: string,
): Promise<ScriptResult> {
  const config = await getConfig();
  const preset = getPresetOrDefault(presetId);

  const modelId = PROMPT_MODEL;
  const [minDur, maxDur] = preset.script.sceneDurationRange;
  const totalDuration = durationMinutes * 60;
  // Le style maison (medium, rendu, qualite) est ajoute par le runner via styleHint.
  // On le passe ici en contexte pour que Claude reste COHERENT avec lui, et on lui
  // interdit d'imposer un medium en dur ("photorealistic, 8k") : sur un preset cartoon
  // (ex. alphonse), "photorealistic" + le suffix "NOT photorealistic" se contredisent.
  const houseStyle = preset.visual.imageStyleSuffix?.trim() || "";

  const response = await callClaudeRetry(modelId, 32000, [{
    role: "user",
    content: `Tu es un expert en production de videos YouTube faceless.

Voici un script brut fourni par l'utilisateur pour une video intitulee "${title}" (niche: "${niche}"), duree cible ${durationMinutes} minutes :

---SCRIPT DEBUT---
${rawText}
---SCRIPT FIN---

Decoupe ce script en scenes. Regles de decoupage :
- Chaque phrase ou groupe de 1-2 phrases courtes = 1 scene
- Garde le texte EXACTEMENT tel quel
- Duree entre ${minDur} et ${maxDur} secondes par scene
- Somme des durees ≈ ${totalDuration} secondes

Regles VISUELLES (critiques — tu es realisateur, pas illustrateur litteral) :
- imagePrompt EN ANGLAIS. Decris UNIQUEMENT le contenu visuel : sujet, action, composition, type de plan, lumiere, ambiance. Format 16:9.
- N'IMPOSE PAS de medium ni de niveau de rendu (PAS de "photorealistic", "8k", "4k", "3D render", "cinematic film still", "hyperrealistic"...) : le style visuel de la chaine est ajoute automatiquement apres ta reponse. Ajouter un medium en dur le contredirait.${houseStyle ? `\n- STYLE MAISON de cette chaine (ajoute ensuite a chaque prompt — tes descriptions doivent rester COHERENTES avec lui et ne JAMAIS le contredire) : ${houseStyle}` : ""}
- Adapte-toi a la niche "${niche}" et au ton du script ci-dessus. Identifie toi-meme les protagonistes, lieux, epoques, objets centraux de CE script.
- Alterne 4 registres scene par scene : (a) PERSONNAGES — quand le script nomme un protagoniste, raconte une action humaine, ou utilise "il/elle/they", montre cette personne en situation concrete, (b) METAPHORES visuelles — quand le concept est abstrait, trouve une image symbolique forte propre au sujet du script (pas de texte ni chiffres a l'ecran), (c) OBJETS SYMBOLIQUES — un detail materiel charge de sens dans le contexte du script, (d) LIEUX evocateurs — un decor qui porte l'emotion du moment.
- INTERDICTION ABSOLUE : 2 scenes consecutives sur le meme sujet visuel, la meme metaphore, ou le meme registre repete a l'identique. Scene N+1 doit changer de registre OU de sujet par rapport a scene N.
- Varie les plans : close-up, medium, wide, aerial, POV, over-the-shoulder, tracking. Pas 3 plans du meme type d'affilee.
- Quand le script mentionne explicitement un personnage (par son nom, ou via "he/she/they/I"), MONTRE-LE en situation — ne te rabats pas sur un plan generique du sujet.
- Quand le concept est abstrait, trouve une metaphore visuelle ancree dans l'univers du script (epoque, lieu, niche), pas un cliche generique.
- Pense arc narratif : l'atmosphere visuelle au debut du script doit clairement differer de celle de la fin (lumiere, palette, energie).
- Coherence : si le script a une epoque, un lieu, ou un univers specifique (historique, geographique, culturel), TOUTES les scenes doivent y rester ancrees. Pas de melange d'epoques ou de cultures.

Reponds en JSON strict :
{
  "scenes": [
    { "index": 0, "narration": "...", "imagePrompt": "Wide shot of ..., dramatic side light, tense mood, 16:9", "durationSeconds": ${Math.round((minDur + maxDur) / 2)} }
  ]
}`,
  }], "Claude Custom");

  const text = response.content[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude Custom: pas de JSON valide dans la reponse");

  const parsed = JSON.parse(jsonMatch[0]);
  const scenes: ScriptScene[] = parsed.scenes.map((s: ScriptScene, i: number) => ({
    index: i,
    narration: s.narration,
    imagePrompt: s.imagePrompt,
    durationSeconds: s.durationSeconds || Math.round(totalDuration / parsed.scenes.length),
  }));

  const fullScript = scenes.map((s) => s.narration).join("\n\n");
  const wordCount = fullScript.split(/\s+/).length;
  console.log(`[Claude] Custom: ${wordCount} mots, ${scenes.length} scenes`);
  return { fullScript, scenes, wordCount };
}

// ===================================================================
// PUBLIC: extractCustomScriptWithPrompts — extract narration + image prompts verbatim from a txt that ALREADY contains both.
// Use this when the user's input has image prompts inline (e.g. "Narration: ... / Image: ..." or "[IMAGE] ... [/IMAGE]").
// Throws on error.
// ===================================================================
export async function extractCustomScriptWithPrompts(
  rawText: string,
  title: string,
  niche: string,
  durationMinutes: number,
  presetId?: string,
): Promise<ScriptResult> {
  const config = await getConfig();
  const preset = getPresetOrDefault(presetId);

  const modelId = PROMPT_MODEL;
  const [minDur, maxDur] = preset.script.sceneDurationRange;
  const totalDuration = durationMinutes * 60;

  const response = await callClaudeRetry(modelId, 16384, [{
    role: "user",
    content: `Tu es un parseur strict. L'utilisateur fournit un script qui contient DEJA pour chaque scene : une narration ET un image prompt (visual). Ta seule mission est d'EXTRAIRE ces 2 elements, scene par scene, en preservant le texte EXACT. Tu n'inventes rien, tu ne reformules rien.

Video : "${title}" (niche : "${niche}"), duree cible ${durationMinutes} minutes.

---SCRIPT DEBUT---
${rawText}
---SCRIPT FIN---

Regles d'extraction :
- Le script peut utiliser n'importe quel format : "Scene 1: ... / Image: ...", "[NARRATION] ... [IMAGE] ...", sections markdown "## Scene N", blocs separes par lignes vides, JSON inline, "Visual:", "Prompt:", "VO:", "Voiceover:", "Narration:", etc. Detecte le pattern.
- La NARRATION est le texte parle par le narrateur (voix off). Recopie-la EXACTEMENT, sans la modifier, sans ajouter de markers.
- L'IMAGE PROMPT est la description visuelle. Recopie-la EXACTEMENT, telle qu'elle est. Si elle est en francais, garde-la en francais. Si en anglais, garde l'anglais. NE LA TRADUIS PAS, NE LA REFORMULE PAS.
- Si une scene n'a clairement PAS d'image prompt explicite dans le texte, mets imagePrompt = "" (chaine vide). Ne genere PAS de prompt de remplacement.
- Une scene = un couple (narration, imagePrompt). Conserve l'ordre du script.
- Duree par scene entre ${minDur} et ${maxDur} secondes. Si le script indique une duree explicite ("8s", "10 sec", etc.) utilise-la, sinon repartis ${totalDuration}s sur le nombre de scenes detectees.
- Ignore les meta-instructions (titres de chapitre, commentaires entre crochets non visuels, notes de production) : ne les mets ni dans narration ni dans imagePrompt.

Reponds en JSON strict, RIEN d'autre :
{
  "scenes": [
    { "index": 0, "narration": "texte VO recopie verbatim", "imagePrompt": "image prompt recopie verbatim", "durationSeconds": ${Math.round((minDur + maxDur) / 2)} }
  ]
}`,
  }], "Claude Extract");

  const text = response.content[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude Extract: pas de JSON valide dans la reponse");

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error("Claude Extract: aucune scene detectee dans le script");
  }

  const fallbackDuration = Math.round(totalDuration / parsed.scenes.length);
  const scenes: ScriptScene[] = parsed.scenes.map((s: ScriptScene, i: number) => ({
    index: i,
    narration: (s.narration ?? "").trim(),
    imagePrompt: (s.imagePrompt ?? "").trim(),
    durationSeconds: s.durationSeconds || fallbackDuration,
  }));

  const missingPrompts = scenes.filter((s) => !s.imagePrompt).length;
  if (missingPrompts > 0) {
    console.warn(`[Claude] Extract: ${missingPrompts}/${scenes.length} scenes sans imagePrompt — elles utiliseront un fallback en aval`);
  }

  const fullScript = scenes.map((s) => s.narration).join("\n\n");
  const wordCount = fullScript.split(/\s+/).length;
  console.log(`[Claude] Extract: ${wordCount} mots, ${scenes.length} scenes (${scenes.length - missingPrompts} avec image prompt verbatim)`);
  return { fullScript, scenes, wordCount };
}

// ===================================================================
// PUBLIC: parseImagePromptsTxt — synchronous regex parser for the sticky format
// Two header shapes are supported:
//   A. "IMAGE N — MM:SS–MM:SS"   → durée déduite des timestamps
//   B. "IMAGE N — title libre"   → durée par défaut (DEFAULT_SEGMENT_DUR=3s)
// Bodies can be either:
//   - "Phrase :"/"Intention :"/"Prompt :" blocks (Format A user .txt), or
//   - prompt direct multilignes after the header (Format B, gen2.txt style)
// Markdown variants supported: leading "## ", **bold** wrappers, etc.
// Throws if no image block is detected.
// ===================================================================
const DEFAULT_SEGMENT_DUR = 3;

export function parseImagePromptsTxt(rawText: string, fallbackTotalDurationS: number): ScriptResult {
  // Header with OPTIONAL timestamps. Groups: 1=n, 2..5=mm:ss-mm:ss (optional)
  const headerRe = /(?:^|\n)\s*#{0,4}\s*IMAGE\s+(\d+)\s*[—–\-]\s*(?:(\d{1,2}):(\d{2})\s*[–—\-]\s*(\d{1,2}):(\d{2}))?[^\n]*/gi;

  type Header = { n: number; bodyStart: number; bodyEnd: number; hasTs: boolean; startS: number; endS: number };
  const headers: Header[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(rawText)) !== null) {
    const hasTs = m[2] !== undefined;
    headers.push({
      n: parseInt(m[1], 10),
      hasTs,
      startS: hasTs ? parseInt(m[2], 10) * 60 + parseInt(m[3], 10) : 0,
      endS: hasTs ? parseInt(m[4], 10) * 60 + parseInt(m[5], 10) : 0,
      bodyStart: m.index + m[0].length,
      bodyEnd: 0,
    });
  }
  if (headers.length === 0) {
    throw new Error("parseImagePromptsTxt: aucun bloc 'IMAGE N — ...' detecte dans la reponse");
  }
  for (let i = 0; i < headers.length; i++) {
    headers[i].bodyEnd = i + 1 < headers.length ? headers[i + 1].bodyStart - 1 : rawText.length;
  }

  const stripBold = (s: string) => s.replace(/\*\*/g, "").trim();
  const stripQuotes = (s: string) =>
    s.replace(/^["“”'‘’«»\s]+/, "").replace(/["“”'‘’«»\s]+$/, "");

  const scenes: ScriptScene[] = headers.map((h, i) => {
    const body = rawText.slice(h.bodyStart, h.bodyEnd);

    let narration = "";
    const phraseMatch = body.match(/(?:\*\*)?\s*Phrase(?:\s+du\s+script)?\s*(?:\*\*)?\s*:\s*([^\n]+)/i);
    if (phraseMatch) narration = stripQuotes(stripBold(phraseMatch[1]));

    // Find the start of the prompt section. We accept "Prompt :", "**Prompt :**",
    // "Prompt final :", "**Prompt final en anglais :**", etc.
    const promptHeaderRe = /(?:\*\*)?\s*Prompt(?:\s+final(?:\s+en\s+anglais)?)?\s*(?:\*\*)?\s*:\s*\n?/i;
    const promptHeaderMatch = body.match(promptHeaderRe);
    let imagePrompt = "";
    if (promptHeaderMatch && promptHeaderMatch.index !== undefined) {
      imagePrompt = body.slice(promptHeaderMatch.index + promptHeaderMatch[0].length);
    } else {
      // Fallback: strip known meta lines (Phrase, Intention) and treat the rest as the prompt.
      imagePrompt = body
        .split(/\r?\n/)
        .filter((line) =>
          !/^\s*(?:\*\*)?\s*Phrase(?:\s+du\s+script)?\s*(?:\*\*)?\s*:/i.test(line)
          && !/^\s*(?:\*\*)?\s*Intention(?:\s+visuelle)?\s*(?:\*\*)?\s*:/i.test(line),
        )
        .join("\n");
    }

    imagePrompt = stripBold(imagePrompt)
      .replace(/^\s*[—–\-=]{3,}\s*$/gm, "")
      .replace(/^-{3,}\s*$/gm, "")
      .replace(/^\s*```[a-z]*\s*$/gim, "")
      .trim();
    imagePrompt = stripQuotes(imagePrompt);

    let durationSeconds: number;
    if (h.hasTs) {
      const d = h.endS - h.startS;
      durationSeconds = d > 0 ? d : DEFAULT_SEGMENT_DUR;
    } else {
      durationSeconds = DEFAULT_SEGMENT_DUR;
    }

    return { index: i, narration, imagePrompt, durationSeconds };
  });

  // If no header had timestamps at all and we have a meaningful fallback total,
  // distribute it. Otherwise stick to DEFAULT_SEGMENT_DUR per scene.
  const noneHadTs = headers.every((h) => !h.hasTs);
  if (noneHadTs && fallbackTotalDurationS > 0 && fallbackTotalDurationS > scenes.length * DEFAULT_SEGMENT_DUR * 1.5) {
    const fallback = Math.max(1, Math.round(fallbackTotalDurationS / scenes.length));
    for (const sc of scenes) sc.durationSeconds = fallback;
  } else {
    for (const sc of scenes) if (sc.durationSeconds <= 0) sc.durationSeconds = DEFAULT_SEGMENT_DUR;
  }

  const missing = scenes.filter((s) => !s.imagePrompt).length;
  if (missing > 0) {
    throw new Error(`parseImagePromptsTxt: ${missing}/${scenes.length} blocs sans 'Prompt :' detectable`);
  }

  const fullScript = scenes.map((s) => s.narration).filter(Boolean).join("\n\n");
  const wordCount = fullScript.split(/\s+/).filter(Boolean).length;
  console.log(`[parseImagePromptsTxt] ${scenes.length} images, total=${scenes.reduce((s, sc) => s + sc.durationSeconds, 0)}s`);
  return { fullScript, scenes, wordCount };
}

// ===================================================================
// PUBLIC: generateStickyPrompts — call Claude with the user's style prompt
// (as instructions) + the raw script, and request a TEXT output in the
// IMAGE N — MM:SS–MM:SS format. Parsed locally via parseImagePromptsTxt —
// no JSON.parse, no malformed-JSON failures.
// ===================================================================
export async function generateStickyPrompts(
  customScript: string,
  stylePrompt: string,
  durationMinutes: number,
): Promise<ScriptResult> {
  const config = await getConfig();
  const modelId = PROMPT_MODEL;

  const userContent = `${stylePrompt}

━━━━━━━━━━━━━━
SCRIPT À TRANSFORMER
━━━━━━━━━━━━━━

${customScript}

━━━━━━━━━━━━━━
FORMAT DE SORTIE OBLIGATOIRE
━━━━━━━━━━━━━━

Pour CHAQUE segment d'environ 3 secondes, retourne EXACTEMENT ce bloc, séparé par une ligne vide :

IMAGE X — MM:SS–MM:SS
Phrase du script : [phrase en français recopiée]
Intention visuelle : [intention courte en français]
Prompt :
[prompt complet en anglais, sur plusieurs lignes si besoin]

Règles strictes du format :
- Le header "IMAGE X — MM:SS–MM:SS" doit être sur SA propre ligne, sans markdown autour
- Utilise un tiret cadratin "—" entre le numéro et le timestamp
- Les timestamps sont consécutifs : IMAGE 1 = 00:00–00:03, IMAGE 2 = 00:03–00:06, etc.
- Ne mets RIEN d'autre que cette liste (pas d'intro, pas de conclusion, pas de bloc markdown englobant)
- Le prompt anglais doit être directement utilisable dans un générateur d'image, prêt à copier-coller`;

  const response = await callClaudeRetry(modelId, 32000, [{
    role: "user",
    content: userContent,
  }], "Claude Sticky");

  const text = response.content[0]?.text || "";
  const totalDurS = Math.max(60, Math.round(durationMinutes * 60));
  const result = parseImagePromptsTxt(text, totalDurS);
  console.log(`[Claude Sticky] ${result.scenes.length} images parsees`);
  return result;
}

// ===================================================================
// PUBLIC: rewriteCompetitorScript — take a competitor transcript and produce
// an anti-plagiat version that preserves the winning structure (hook, beats,
// CTA placement, callbacks) but rewords ~20% and lightly restructures so the
// output passes a plagiat checker.
// Returns a clean narration text usable as `customScript` downstream.
// ===================================================================
export async function rewriteCompetitorScript(
  transcript: string,
  myTitle: string,
  niche: string,
  targetDurationMinutes: number,
): Promise<string> {
  const config = await getConfig();
  const modelId = getModelId(config);

  // ElevenLabs reads ~150 wpm; pad target by 10% so the writer has elbow room.
  const targetWords = Math.round(targetDurationMinutes * 150 * 1.1);

  const prompt = `Tu reçois le transcript d'une vidéo YouTube qui marche bien dans la niche "${niche}".
Ton job : produire une VERSION RÉÉCRITE pour MA chaîne, sur le sujet "${myTitle}".

Objectifs :
- GARDE tout ce qui rend la vidéo gagnante : structure narrative, ordre des beats, hook d'ouverture (forme, pas mots), placement des callbacks, ratio info/storytelling, CTA. Si la vidéo source a une formule type "But what if I told you X" → garde l'ESPRIT de cette formule, pas les mots.
- CHANGE ~20% des mots : synonymes, reformulations de phrases, variation des connecteurs, switch actif↔passif là où c'est naturel.
- NE CHANGE PAS les chiffres, dates, noms propres factuels, ni la chronologie des arguments.
- ADAPTE le sujet si nécessaire pour qu'il colle à "${myTitle}" (le sujet peut différer du transcript source — utilise la STRUCTURE du transcript appliquée à mon sujet).
- VISE ~${targetWords} mots (≈ ${targetDurationMinutes} min de narration à 150 wpm).
- Ton : prose continue, lisible à voix haute. Pas de markdown, pas de titres de section, pas de "[INTRO]", pas de listes. Juste le texte narratif.

REGLES STRICTES :
- N'écris RIEN d'autre que le script final. Pas de préambule, pas de commentaire, pas de méta.
- Pas de phrases qui copient mot-pour-mot 8+ mots consécutifs du transcript source.
- Pas de répétitions inutiles : si le transcript boucle, lisse la version réécrite.

TRANSCRIPT SOURCE :
"""
${transcript}
"""

Maintenant écris ma version réécrite (juste le texte narratif, rien d'autre) :`;

  const response = await callClaudeRetry(
    modelId,
    8192,
    [{ role: "user", content: prompt }],
    "Claude Competitor Rewrite",
  );

  const text = (response.content[0]?.text || "").trim();
  if (text.length < 200) {
    throw new Error(`rewriteCompetitorScript: réponse trop courte (${text.length} chars)`);
  }
  console.log(`[Claude] rewriteCompetitorScript: ${text.split(/\s+/).length} mots`);
  return text;
}

// ===================================================================
// PUBLIC: consolidateStyleBrief — merge N per-frame style descriptions
// (from describeStyle / Haiku Vision) into ONE compact paragraph suitable
// as a `customStyle` prompt suffix on every image gen.
// ===================================================================
export async function consolidateStyleBrief(perFrameBriefs: string[]): Promise<string> {
  const config = await getConfig();
  const modelId = PROMPT_MODEL;

  const clean = perFrameBriefs.map((b) => b.trim()).filter((b) => b.length > 20);
  if (clean.length === 0) throw new Error("consolidateStyleBrief: aucune description exploitable");

  const numbered = clean.map((b, i) => `[FRAME ${i + 1}]\n${b}`).join("\n\n");

  const prompt = `Tu reçois ${clean.length} descriptions de style visuel, chacune analysant une frame différente d'une même vidéo YouTube. Fusionne-les en UN SEUL paragraphe de prompt suffix utilisable par un modèle image (nano_banana_pro / Veo).

Objectifs :
- Identifier les éléments RÉCURRENTS (palette, trait, anatomie character, composition) et les nommer précisément.
- Ignorer le bruit (variations ponctuelles d'une scène) — garde ce qui revient dans au moins 3 frames.
- Format : un paragraphe dense, 80-140 mots, en ANGLAIS, descriptif, sans bullets, sans préambule.
- Le résultat doit pouvoir être collé tel quel à la fin d'un prompt image existant (donc commence par une virgule implicite : "flat 2D cartoon illustration with…").
- Mentionne explicitement : médium, épaisseur/couleur du trait, anatomie character si récurrent (forme de tête, proportions, type de mains), 3-4 couleurs dominantes nommées, mood lumineux, texture/grain. Termine par "16:9".

Ne réponds qu'avec le paragraphe final. Pas de "Voici…", pas de markdown, pas de guillemets autour.

DESCRIPTIONS :
${numbered}`;

  const response = await callClaudeRetry(
    modelId,
    1024,
    [{ role: "user", content: prompt }],
    "Claude Style Brief",
  );
  const text = (response.content[0]?.text || "").trim().replace(/^[`"'\s]+|[`"'\s]+$/g, "");
  if (text.length < 60) throw new Error(`consolidateStyleBrief: réponse trop courte (${text.length} chars)`);
  console.log(`[Claude] consolidateStyleBrief: ${text.split(/\s+/).length} mots`);
  return text;
}

// ===================================================================
// PUBLIC: rankRefsForScenes — one-shot semantic matcher.
// Given a set of scene image prompts and a set of pre-described kit images
// (filename + imagePrompt), returns, per scene, the top-N kit filenames that
// best match. Used by /pipeline when the user picks a describe-mode style kit.
// ===================================================================
export interface RankRefSceneInput {
  index: number;
  imagePrompt: string;
}
export interface RankRefKitImage {
  filename: string;
  imagePrompt: string;
}
export interface RankRefSceneOutput {
  index: number;
  filenames: string[];
}

export async function rankRefsForScenes(
  scenes: RankRefSceneInput[],
  kitImages: RankRefKitImage[],
  topN = 5,
): Promise<RankRefSceneOutput[]> {
  if (scenes.length === 0 || kitImages.length === 0) return [];

  const config = await getConfig();
  const modelId = PROMPT_MODEL;

  const validKit = kitImages.filter((k) => (k.imagePrompt ?? "").trim().length > 20);
  if (validKit.length === 0) throw new Error("rankRefsForScenes: aucun imagePrompt exploitable dans le kit");

  const kitBlock = validKit
    .map((k) => `[FILE ${k.filename}]\n${k.imagePrompt.trim()}`)
    .join("\n\n");

  const scenesBlock = scenes
    .map((s) => `[SCENE ${s.index}]\n${(s.imagePrompt ?? "").trim()}`)
    .join("\n\n");

  const N = Math.max(1, Math.min(topN, validKit.length));

  const prompt = `Tu reçois (A) une banque de ${validKit.length} images de référence — chacune décrite par un prompt image-gen détaillé — et (B) ${scenes.length} scènes de pipeline. Pour CHAQUE scène, choisis les ${N} fichiers de la banque dont la description correspond le mieux au prompt de la scène (sujet, ambiance, médium, palette, composition).

Règles :
- Renvoie EXACTEMENT ${N} filenames par scène, par ordre décroissant de pertinence.
- Utilise UNIQUEMENT les filenames listés dans la banque (copie exacte, casse comprise).
- Tu peux réutiliser un même fichier sur plusieurs scènes si pertinent.
- Privilégie la cohérence visuelle : si une scène mentionne un humain/personnage, pioche les refs qui en montrent un ; sinon refs de décor/objet/palette.

Réponds avec UN SEUL bloc JSON, sans markdown, sans préambule, format strict :
{"scenes":[{"index":<int>,"filenames":["<file>","<file>",...]},...]}

=== BANQUE D'IMAGES ===
${kitBlock}

=== SCÈNES ===
${scenesBlock}`;

  const maxTokens = Math.min(32000, 200 + scenes.length * (N * 60));
  const response = await callClaudeRetry(
    modelId,
    maxTokens,
    [{ role: "user", content: prompt }],
    "Claude Rank Refs",
  );
  const raw = (response.content[0]?.text || "").trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: { scenes?: Array<{ index?: number; filenames?: unknown }> };
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`rankRefsForScenes: JSON invalide — ${(err as Error).message}. Début réponse: ${stripped.slice(0, 200)}`);
  }

  const validNames = new Set(validKit.map((k) => k.filename));
  const out: RankRefSceneOutput[] = [];
  for (const row of parsed.scenes ?? []) {
    if (typeof row.index !== "number") continue;
    const names = Array.isArray(row.filenames)
      ? row.filenames
          .filter((n): n is string => typeof n === "string")
          .filter((n) => validNames.has(n))
          .slice(0, N)
      : [];
    out.push({ index: row.index, filenames: names });
  }
  console.log(`[Claude] rankRefsForScenes: ${out.length}/${scenes.length} scènes mappées, top-${N}`);
  return out;
}

// ===================================================================
// PUBLIC: split / generate scenes at EXACTLY 2 seconds per scene.
// Used when the pipeline is running with a describe-mode style kit:
// each scene's imagePrompt is a short action-based description that
// will be paired with a reference image picked by the kit's semantic
// matcher. No verbose cinematic suffix — the refs carry the style.
// ===================================================================
const TWO_SEC_IMAGE_PROMPT_RULES = `Format imagePrompt OBLIGATOIRE (ANGLAIS, une seule phrase, 15-40 mots) :
- Le stickman n'est PAS obligatoire — beaucoup de scènes sont des objets, panneaux, métaphores visuelles SANS personnage. Inclus le stickman UNIQUEMENT quand la scène demande une action humaine, une réaction, un dialogue, ou un personnage qui pointe/touche/regarde quelque chose.
  - Avec stickman → commence par "The stickman" (jamais "A stickman", jamais nommé).
  - Sans stickman → commence directement par l'objet/concept : "A campfire…", "A cave entrance labeled SOUTH AFRICA…", "A red X crosses out a glowing screen…", "A split clock face…"
- Décris UNE chose principale + le décor minimal + tout texte écrit dans la scène (labels, panneaux, bulles, chiffres, dates).
- Pas de description de style visuel (pas de "flat 2D", pas de palette, pas de "16:9") — le style vient des refs.
- Varie le rythme stickman/objet : alterne pour éviter que chaque scène soit "stickman fait X". Si le DOCUMENT DE RÉFÉRENCE contient surtout des objets/scènes sans personnage, suis ce ratio.
- Exemples cible :
  • avec stickman : "The stickman stands between a house sign labeled Rental Property and a chart screen labeled Index Funds while two speech bubbles read Smarter Choice."
  • sans stickman : "A cave entrance half-buried in earthy brown ground with a small orange flame inside and a red location pin labeled SOUTH AFRICA hovering above."
  • sans stickman : "A bold red X crosses out a glowing rectangle labeled SCREEN above a lightbulb labeled ELECTRICITY."`;

function buildVocabBlock(kitImagePrompts: string[]): string {
  if (!kitImagePrompts || kitImagePrompts.length === 0) return "";
  // Cap to keep prompt tractable — 80 refs × ~120 words = ~10k tokens.
  const sample = kitImagePrompts.slice(0, 80);
  return `

DOCUMENT DE RÉFÉRENCE (vocabulaire visuel disponible — chaque entrée décrit UNE image de référence existante du kit) :
${sample.map((p, i) => `[REF ${i + 1}] ${p}`).join("\n")}

Sers-toi de ce vocabulaire pour calibrer ce qui est dessinable : sujets stickman, props (campfire, sign, chart, speech bubble, cave, arrow…), gestes, mises en scène. Tes imagePrompts doivent rester dans cet univers visuel — chaque scène doit pouvoir s'appuyer sur une ou deux de ces refs.`;
}

const ADAPTIVE_DURATION_RULES = `Règles durée — RYTHME ULTRA DYNAMIQUE (priorité absolue : rétention) :
- Cible moyenne : 1.5 secondes par scène. Maximum absolu : 2 secondes.
- Choisis UNIQUEMENT dans {1, 1.5, 2}. Jamais plus de 2s.
- 1s = mots-choc, révélation, punchline, chiffre-choc, négation, mot isolé fort
- 1.5s = la majorité des scènes (rythme par défaut)
- 2s = uniquement pour les explications denses, jamais pour de la narration plate
- COUPE AGRESSIVEMENT : chaque virgule, chaque sous-clause, chaque préposition narrative ("when …", "but …", "and so …", "then …") est un cut potentiel. Une phrase longue se découpe en 3-5 scènes, pas en 1.
- Exemple : "When the sun goes down, predators come out" → 2 scènes :
   1. (1.5s) narration "When the sun goes down" + imagePrompt sunset/horizon
   2. (1.5s) narration "predators come out" + imagePrompt glowing eyes in dark
- Plus c'est intense, plus la rétention monte. Si tu hésites entre 1.5s et 2s → choisis 1.5s.`;

// Stickman/whiteboard system prompt (user-provided 2026-05-16).
// Notes d'intégration : on retire les parties incompatibles avec le flow verbatim
// (cut aggressively / output per line / do not stop at 30 prompts) car la découpe
// est déjà faite en JS pur en amont — Claude génère 1 imagePrompt par segment fourni.
const STICKMAN_IMAGE_SYSTEM = `You are a specialized prompt generator that transforms video script lines into ultra-simple visual beats for fast-paced YouTube-style editing.

You receive a list of pre-segmented narration beats (one per scene). You must generate ONE image prompt per beat, in order, never merging or skipping. The segmentation is fixed in advance.

Think like a YouTube editor, not like an illustrator. The goal is to build a fast, clear, high-retention visual sequence that follows the script from A to Z. The visuals must change often.

CORE VISUAL GOAL
The visuals must be ultra-simple, instantly readable, and useful for editing. Do not think like a painter. Do not think like a filmmaker. Think like a YouTube editor building a fast sequence of clean visual beats.

VISUAL STYLE
Every prompt must describe a very simple stickman-style image, or a very simple object-centered image when appropriate. All humans must be stickmen. The visual style is: very simple, childlike, mostly white background, minimal objects, thin slightly wobbly black lines, big round stickman head, simple stick body, simple expressive eyes, no realistic anatomy, no detailed clothes, no 3D, no shadows, no gradients, no cinematic look, no complex background.

PROMPT STRUCTURE
Each prompt must be one clear standalone sentence. Each prompt should clearly communicate: who or what is shown, where it is, what is happening, and the key visual objects, symbols, labels, chart, timeline, or visual metaphor. Stay simple, but not too short or vague.
Bad:  "The stickman sees a tooth."
Good: "The stickman sits in a modern dentist chair while a tiny drill spins near his open mouth."
Good: "The stickman stands in a prehistoric cave, holding his swollen cheek beside a giant rotten tooth."
Good: "A giant rotten tooth cracks on a white background with a small warning label reading 'Decay'."

PROMPT LENGTH
Aim for around 18 to 35 words per prompt. Descriptive enough to be useful. Never overly detailed. Never describe complex backgrounds.

CHARACTER RULE
All humans must be stickmen. Never realistic humans. Never detailed facial features, anatomy, or clothing.

OBJECT PRIORITY RULE
Do not rely mostly on stickmen. Whenever a concept can be shown clearly with an object, tool, symbol, sign, label, chart, map, timeline, number, or simple visual metaphor, prefer the object.

VISUAL VARIETY RULE — HARD DISTRIBUTION (mandatory)
Across the full sequence, the distribution MUST be approximately:
- 30% — stickman INTERACTING WITH OTHER STICKMAN(S): conversation, comparison between two people, crowd, group, audience, observer-vs-actor, before/after person, two stickmen pulling rope, etc.
- 40% — stickman IN A SCENE/SETTING: stickman beside a campfire, in a cave, on a hill, near a stone circle, on a beach, under stars, beside a river, inside a tent, on a mountain top, in a forest, near a workshop. The setting carries the meaning.
- 30% — OBJECTS ONLY (no stickman at all): candles, timelines, calendars, bones with notches, gears, melting clocks, scales, broken pottery, maps, charts, target/arrow, magnifying glass, stone tablet, hourglass, sundial.

NEVER produce a stickman alone on a plain white background with no other figure, no setting, no object interaction. Every stickman MUST be either with another stickman, in a setting, or holding/using a specific object. Plain "stickman standing on white" is FORBIDDEN.

Alternate constantly — never two of the same category in a row.

OBJECT-CENTERED SCENES
Some prompts should contain no stickman at all if the idea is clearer as a pure object shot. Examples: a rotten tooth cracking, a drill spinning, a timeline labeled "300,000 Years", crossed-out icons for "No Toothbrush" / "No Toothpaste" / "No Antibiotics", a jawbone with a dark abscess hole, a bowl of sticky acorn paste, a bow drill aimed at a tooth, a tooth filled with beeswax, a gold dental bridge, iron pliers pulling a tooth, a warning sign over an infected molar, a simple map with a highlighted location, a study paper with a date and numbers, a cracked calendar, a misaligned gear, a melting clock, a target hit perfectly in the center, a puzzle piece that refuses to fit, a magnifying glass revealing a hidden detail.

PRIORITY DECISION RULE
For each line of the script, first ask: "Would this be clearer as an object-based visual?" If yes → object-centered or mixed. If no → stickman-centered.

VISUAL INTERPRETATION RULE
Never illustrate the sentence literally if the sentence is abstract, transitional, emotional, or rhetorical. Before writing each image prompt, first identify the hidden visual idea behind the narration.

Do NOT visualize words like:
strange, important, incredible, shocking, here's the thing, the problem is, but, however, because, this changed everything, it flowed, it mattered, it was precise, they understood, they believed, stunning, astonishing, fascinating, underrated, impossible, powerful.

Instead, visualize the concrete tension, contradiction, mechanism, object, consequence, or proof behind the sentence.

For every narration line, silently convert it into:
- What is the real idea?
- What is the visual proof of that idea?
- What object, comparison, symbol, mechanism, or physical metaphor makes it instantly clear?

A good prompt should image the meaning behind the sentence, not the words inside the sentence.

IMAGEABILITY RULE
Do not choose a visual because it technically matches the sentence. Choose the visual that makes the hidden idea physically visible. Before writing the image prompt, classify the narration as one of these:

FACT — Show the concrete object, number, place, or mechanism.

TRANSITION — Do not show a stickman reacting. Show the next idea as a mystery, anomaly, crack, hidden detail, or reveal.

ABSTRACT IDEA — Use a metaphor: melting clock, misaligned gear, broken calendar, puzzle piece, target, ribbon, scale, trapdoor, magnifying glass, cracked object, stretched object, shrinking object.

COMPARISON — Use side-by-side contrast, but make the difference physical, not just text labels.

PRECISION — Use target, alignment, tiny gap, microscope, measuring line, perfectly fitting gears, exact center hit, or two almost identical numbers.

UNCERTAINTY — Show multiple possible meanings branching from the same object.

MEMORY / KNOWLEDGE — Show invisible thoughts becoming physical marks, maps, calendars, stones, tools, or records.

TIME — Choose the time metaphor carefully:
- natural time = sun, moon, seasons, shadows
- mechanical time = clock, gear, factory, schedule
- flexible time = ribbon, melting clock, stretching segments
- historical time = timeline
- measured time = marks, targets, grids, instruments
- synchronized time = grid, tower, train schedule, factory clock

BORING IDEA REJECTION
Reject any prompt that only shows: a stickman surprised, a stickman pointing, a stickman looking at something, a speech bubble repeating the narration, a big label with the abstract idea, a generic timeline, two words compared on a blank background, a plain question mark, a trophy for achievement, a character celebrating without showing what was achieved.

A prompt is weak if the viewer needs to read the label to understand it. A prompt is strong if the image still communicates the idea even with the label removed.

For every narration line, silently create 3 possible concepts: literal visual, metaphor visual, consequence visual. Pick the strongest one based on: visual tension, clarity, motion, curiosity, low dependency on text, direct connection to the next narration line. Never choose the boring literal option unless it is genuinely the clearest.

TRANSITION SENTENCE RULE
If the narration is a transition like "But here's the strange part.", "And the most stunning part?", "But what we do know is this.", "This changed everything.", "Here is the problem.", "The real answer is stranger." → do NOT show a stickman reacting. Instead, use the transition to foreshadow the next concrete idea.

Show: a cracked object, a hidden detail, a wrong piece in a puzzle, a door slightly open, a warning mark, a normal object with one impossible element, a magnifying glass revealing something unusual, a mechanism that is about to be explained, a diagram with one part behaving strangely.

Bad:
  Narration: "But here's the strange part."
  Prompt:    "A stickman looks surprised with a speech bubble saying 'strange part'."
Good:
  Narration: "But here's the strange part."
  Prompt:    "A magnifying glass hovers over an Egyptian water clock, revealing that the hour marks are unevenly spaced instead of perfectly equal."

PRECISION RULE
When the narration says precision, accurate, exact, or close, do not show the word precision. Show accuracy visually: arrow hitting the center of a target, calendar gear fitting perfectly, measuring line matching exactly, star chart aligned with a calendar, two systems compared (one accurate, one off-center), a tiny red gap under a magnifying glass, nearly identical numbers almost touching.

Bad:
  Narration: "Their astronomers had achieved a level of precision..."
  Prompt:    "A timeline says Maya and Gregorian Reform."
Good:
  Narration: "Their astronomers had achieved a level of precision..."
  Prompt:    "A Mayan calendar gear clicks perfectly into a star-shaped machine, while a European calendar gear stays crooked beside the date 1582."

TIME FEELING RULE
When the narration talks about how time felt, do not default to normal clocks. Use the correct time metaphor:
- flexible time = ribbon, melting clock, stretching segments
- body time = stickman moving with a flowing ribbon
- nature time = sun, moon, weather, seasons
- vague time = candle burning, prayer book, sundial, shadow
- machine time = factory clock, train schedule, telegraph, grid

Bad:
  Narration: "Time was elastic. It flowed with the body."
  Prompt:    "11:43 AM and 11:44 AM with a red X."
Good:
  Narration: "Time was elastic. It flowed with the body."
  Prompt:    "A walking stickman is wrapped in a soft wavy ribbon labeled time, while small sun, cloud, and leaf icons flow around the body."

VISUAL METAPHOR PRIORITY
For every scene, prefer a concrete visual metaphor over a label. Labels can support the image, but must never be the whole idea. If the image still works without reading the text label → good. If the image only works because of the label → weak.

SCENE BREAKDOWN RULE
Follow the script in exact chronological order. Do not skip important ideas. Create a new visual setup whenever the script introduces: a new action, a new number, a comparison, a cost, a risk, a danger, a discovery, a study, a location, a time period, a tool, a disease, a strong emotional shift, a cause-and-effect moment, a contradiction, an anomaly, a hidden mechanism.

ANTI-BORING RULE
Never repeat the same visual setup more than 2 scenes in a row. If the previous prompt shows a stickman standing beside something, the next should use a different visual mechanic. Alternate often between: stickman action, object-only shot, mixed scene, split-screen, before/after, warning sign, cracked label, timeline, map, chart, giant object, arrows, falling/moving elements, comparison board, crossed-out icons, magnifying glass reveal, misaligned machine, target hit or missed, puzzle piece mismatch, object transforming.

Avoid repeating: "stands beside", "points at", "looks at", "speech bubble reading", "bold label reading".

LABEL RULE
Use short labels when helpful, usually 1–4 words max. Good: "$50,000", "Mortgage", "Hidden Costs", "15,000 Years Ago", "No Anesthesia", "Morocco", "Study", "Abscess", "1582", "Not Equal", "One Sunrise", "Natural Time", "Machine Time". Bad: long full sentences, abstract explanations, or large chunks of script.

FINANCIAL / EDUCATIONAL VISUAL RULE
When the script includes money, studies, numbers, timelines, risks, pain, danger, or comparisons, make them highly visual. Use moving money, charts, warning signs, shrinking numbers, split screens, labels, arrows, giant numbers, object comparisons, simple diagrams, targets, magnifying glasses, measuring lines, cracked symbols.

REFERENCE FRAME RULE
If the user provides reference frames, use them as style references only. Do not copy the exact composition unless the narration clearly requires it. Choose the reference frame based on the visual mechanic: timeline refs for timeline scenes, label refs for bold text scenes, stickman refs for character emotion scenes, object refs for object-centered scenes, split-screen refs for comparisons, map refs for location scenes, diagram refs for mechanism scenes, warning refs for danger scenes. Do not blindly reuse the same reference frame just because it appeared before. The image prompt must be driven by the narration first, then matched to the closest visual style reference. If no reference clearly fits, still write the best simple prompt.

STARTING RULE
Most character scenes should start with "The stickman". Purely object-based scenes do not need to start with "The stickman".

FINAL CHECK BEFORE OUTPUT
Before finalizing each prompt, make sure: it is one sentence, it is simple, it is visual, it is not too vague, it contains a clear subject/place/action/object-or-symbol, it does not overuse stickmen, it does not repeat the previous visual setup, it follows the script in order, it images the hidden meaning (not just the literal words), it would still make sense if most labels were removed, it is not a dead visual idea.`;

// Pure JS segmentation: split on punctuation boundaries while preserving the original text verbatim.
// Returns scenes whose concatenated narrations equal the input (modulo whitespace normalization).
function segmentScriptVerbatim(text: string): Array<{ narration: string; durationSeconds: number }> {
  // Tuned for ~2s/scene average on standard English narration (2.5 words/sec).
  // Splits ONLY on punctuation boundaries — never breaks mid-phrase, preserves verbatim.
  const TARGET_WORDS = 2;
  const MIN_WORDS = 1;
  const MAX_WORDS = 3;

  const normalized = text.replace(/\s+/g, " ").trim();

  // 1) Cut at any of . ! ? ; , — keep the punctuation attached to the preceding chunk.
  //    Skip commas that sit between two digits ("300,000") and dots inside decimals/abbrev that we keep simple.
  const chunks: string[] = [];
  let current = "";
  const isDigit = (c: string) => c >= "0" && c <= "9";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    current += ch;
    if (".!?;,".includes(ch)) {
      const prev = normalized[i - 1];
      const next = normalized[i + 1];
      // Don't split inside numbers ("300,000", "29.5").
      if ((ch === "," || ch === ".") && prev && next && isDigit(prev) && isDigit(next)) continue;
      // Don't split on a period that's part of an initialism/abbreviation: a single
      // letter at a word boundary, e.g. "U.S.", "U. S.", "a.m.", "Ph.D." — otherwise
      // "U.S." is cut into "U." + "S." and rejoined as "U. S.", breaking the verbatim
      // guarantee (splitScriptInto2sScenes narration-divergence guard then throws).
      if (ch === "." && prev && /[a-zA-Z]/.test(prev)) {
        const before = normalized[i - 2];
        if (before === undefined || before === " " || before === ".") continue;
      }
      // Pull any trailing closing-quote into the current chunk so "Ave Maria," stays a single token
      // instead of being split into "Ave Maria, and a stranded ".
      while (i + 1 < normalized.length && `"'’”»`.includes(normalized[i + 1])) {
        current += normalized[i + 1];
        i++;
      }
      while (i + 1 < normalized.length && normalized[i + 1] === " ") i++;
      const trimmed = current.trim();
      if (trimmed) chunks.push(trimmed);
      current = "";
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // 2) Greedy merge so each segment lands between MIN_WORDS and MAX_WORDS, preferring TARGET_WORDS.
  const segments: Array<{ narration: string; durationSeconds: number }> = [];
  let buf = "";
  let bufWords = 0;
  const flush = () => {
    if (!buf.trim()) return;
    const n = buf.trim();
    const w = n.split(/\s+/).filter(Boolean).length;
    let d: number;
    const s = w / 2.5;
    if (s < 1.25) d = 1;
    else if (s < 1.75) d = 1.5;
    else d = 2;
    segments.push({ narration: n, durationSeconds: d });
    buf = "";
    bufWords = 0;
  };

  for (const ch of chunks) {
    const w = ch.split(/\s+/).filter(Boolean).length;
    // If the incoming chunk alone is huge: prepend any short pending buffer (avoid orphan 1-word segments) then emit.
    if (w > MAX_WORDS) {
      const merged = buf.trim() ? `${buf.trim()} ${ch}` : ch;
      buf = ""; bufWords = 0;
      const totalW = merged.split(/\s+/).filter(Boolean).length;
      const dRaw = totalW / 2.5;
      const d = dRaw < 1.25 ? 1 : dRaw < 1.75 ? 1.5 : 2;
      segments.push({ narration: merged, durationSeconds: d });
      continue;
    }
    if (buf && bufWords + w > MAX_WORDS && bufWords >= MIN_WORDS) {
      flush();
      buf = ch;
      bufWords = w;
    } else {
      buf = buf ? `${buf} ${ch}` : ch;
      bufWords += w;
      if (bufWords >= TARGET_WORDS) flush();
    }
  }
  if (buf.trim()) {
    if (segments.length > 0 && bufWords < MIN_WORDS) {
      const last = segments.pop()!;
      const merged = `${last.narration} ${buf.trim()}`;
      const w = merged.split(/\s+/).filter(Boolean).length;
      const s = w / 2.5;
      const d = s < 1.25 ? 1 : s < 1.75 ? 1.5 : 2;
      segments.push({ narration: merged, durationSeconds: d });
    } else {
      flush();
    }
  }
  return segments;
}

// Classify a kit prompt into one of three visual categories used for forced distribution.
//   STICK  = stickman(s) only, minimal background, no major object — pure character focus
//   OBJECT = no stickman at all, pure object/symbol composition
//   SETTING = stickman placed in a landscape/environment (cave, forest, street, village, market…)
export type SceneCategory = "STICK" | "SETTING" | "OBJECT";
const SETTING_TOKENS = /\b(cave|campfire|hill|mountain|forest|river|beach|stone circle|tent|landscape|outdoor|ground|earth|grass|sand|night sky|stars in|sea|shore|trail|cliff|rock|desert|jungle|snow|horizon|street|alley|village|market|fountain|temple|church|castle|courtyard|garden|farm|barn|workshop|factory|tower|bridge|harbor|valley|meadow|prairie|tundra|swamp|cathedral|monastery|library|stage|amphitheater|colosseum|piazza|boulevard|square|hut|cabin|tent|stadium|arena)\b/i;
export function classifyKitPrompt(p: string): SceneCategory {
  const low = p.toLowerCase();
  const sticks = (low.match(/stickman|stick figure/g) ?? []).length;
  if (sticks === 0) return "OBJECT";
  if (SETTING_TOKENS.test(low)) return "SETTING";
  return "STICK";
}

// Pre-allocate categories for N scenes with target 10% STICK, 60% SETTING, 30% OBJECT.
// Uses a seeded shuffle (deterministic for same n) + a pass that breaks 2-in-a-row runs
// by swapping with a nearby different category.
export function allocateCategories(n: number): SceneCategory[] {
  const targets = { STICK: Math.round(n * 0.10), SETTING: Math.round(n * 0.60), OBJECT: 0 };
  targets.OBJECT = n - targets.STICK - targets.SETTING;
  const arr: SceneCategory[] = [];
  for (let i = 0; i < targets.STICK; i++) arr.push("STICK");
  for (let i = 0; i < targets.SETTING; i++) arr.push("SETTING");
  for (let i = 0; i < targets.OBJECT; i++) arr.push("OBJECT");
  // Seeded shuffle so the distribution is reproducible for the same scene count.
  let seed = 0x12345 ^ n;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  // Break 2-in-a-row runs by swapping with the next different-category slot.
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1]) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j] !== arr[i - 1] && (j + 1 >= arr.length || arr[j + 1] !== arr[i])) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
  return arr;
}

// Build the Claude user prompt for one chunk of segments.
// In remix mode: ask Claude to pick + minimally edit a kit prompt for each narration.
// In from-scratch mode: full STICKMAN_IMAGE_SYSTEM brief, generate from nothing.
// `indexOffset` is the absolute index of `chunk[0]` in the full script — used so Claude returns
// real script indices in its JSON, making merge trivial across parallel chunks.
// `categoriesByAbsIdx` carries the forced category per scene (keyed by absolute scene index).
function buildPrompt(
  useRemixMode: boolean,
  chunk: Array<{ narration: string; durationSeconds: number }>,
  indexOffset: number,
  totalScenes: number,
  kitImagePrompts: string[],
  fullScript: string,
  categoriesByAbsIdx: Map<number, SceneCategory>,
): string {
  // Build per-scene line with FORCED category tag — Claude must respect it.
  const numberedNarrations = chunk
    .map((s, i) => {
      const absIdx = indexOffset + i;
      const cat = categoriesByAbsIdx.get(absIdx) ?? "OBJECT";
      return `${absIdx} [${cat}]: ${s.narration}`;
    })
    .join("\n");

  if (useRemixMode) {
    // Bucket kit prompts by category so Claude only sees relevant candidates per scene.
    const buckets: Record<SceneCategory, Array<{ idx: number; text: string }>> = {
      STICK: [], SETTING: [], OBJECT: [],
    };
    kitImagePrompts.forEach((p, i) => buckets[classifyKitPrompt(p)].push({ idx: i, text: p }));

    const bucketList = (cat: SceneCategory) =>
      buckets[cat].length === 0
        ? "(empty — compose from scratch following the category's visual definition; no kit base needed, use kitBaseIndex: null)"
        : buckets[cat].map((b) => `[K${b.idx}] ${b.text}`).join("\n");

    return `You are a prompt remixer for stickman-style explainer-video frames. Each pre-segmented narration beat has a FORCED visual category (STICK / SETTING / OBJECT). You MUST respect the category for every scene.

═══════════════════════════
CATEGORY DEFINITIONS (hard rules)
═══════════════════════════
STICK   = ONE stickman alone, distinct action, plain white background. NO scenery, NO labels, NO second character.
SETTING = ONE stickman in a LANDSCAPE/ENVIRONMENT (cave, beach, hill, forest, street, village, market, campfire, mountain). Environment clearly visible.
OBJECT  = NO stickman at all. Pure object/symbol composition (candle, timeline, gear, calendar, chart, map, hourglass, stone tablet…).

═══════════════════════════
KIT PROMPTS — grouped by category (pick base from THE CORRECT BUCKET)
═══════════════════════════
--- STICK bucket (${buckets.STICK.length} refs) ---
${bucketList("STICK")}

--- SETTING bucket (${buckets.SETTING.length} refs) ---
${bucketList("SETTING")}

--- OBJECT bucket (${buckets.OBJECT.length} refs) ---
${bucketList("OBJECT")}

═══════════════════════════
REMIX RULES
═══════════════════════════
1. For each narration, read its FORCED category tag, then pick a kit prompt FROM THAT CATEGORY's bucket whose visual structure best matches the narration.
2. SETTING: VARY the landscape across consecutive scenes (cave then hill then market) — avoid two identical settings back-to-back.
3. STICK: ALWAYS NEW pose/action. Never two identical poses consecutively.
4. Vary kit picks — avoid the same K-index within 5 consecutive scenes; spread usage broadly.
5. Edit the picked base minimally: swap labels, replace 1-2 objects, change a number, adjust the action. Light surgery, not rewrite.
6. RESPECT the category strictly: STICK = no scenery; SETTING = environment clearly visible; OBJECT = no stickman.
7. 18-35 words. One English sentence per prompt.
8. NEVER output a kit prompt verbatim; NEVER illustrate transitional/abstract sentences literally.

═══════════════════════════
EXAMPLES (by category)
═══════════════════════════
STICK — Narration: "You're sitting in the dentist's chair."
Remix: "A single stickman sits upright with mouth wide open, eyes slightly squinted, arms resting at sides, against a plain white background."

SETTING — Narration: "They gathered around the fire that night."
Remix: "A stickman crouches beside a small campfire on a rocky hilltop, flames licking upward under a starry night sky, simple ink-line illustration."

OBJECT — Narration: "Every 29.5 days."
Remix: "A horizontal timeline shows 29 small crescent moon icons spaced evenly, with a bold '29.5' label centered above and arrow markers at both ends, on white."

═══════════════════════════
SCOPE
═══════════════════════════
This is chunk covering indices ${indexOffset} to ${indexOffset + chunk.length - 1} of a ${totalScenes}-scene script. Generate EXACTLY ${chunk.length} prompts in order, respecting each scene's FORCED category.

═══════════════════════════
OUTPUT FORMAT (strict JSON only, no markdown, no preamble, no trailing text)
═══════════════════════════
{"prompts":[
  {"index": ${indexOffset}, "category": "STICK|SETTING|OBJECT", "kitBaseIndex": <K-index or null>, "imagePrompt": "<remixed sentence>"},
  ...
]}

═══════════════════════════
NARRATIONS (verbatim, fixed — FORCED category in brackets)
═══════════════════════════
${numberedNarrations}

═══════════════════════════
FULL SCRIPT (context only)
═══════════════════════════
${fullScript}`;
  }

  // From-scratch mode (no kit)
  const vocabBlock = buildVocabBlock(kitImagePrompts);
  return `${STICKMAN_IMAGE_SYSTEM}
${vocabBlock ? `\n${vocabBlock}\n` : ""}
SCOPE
This is chunk covering indices ${indexOffset} to ${indexOffset + chunk.length - 1} of a ${totalScenes}-scene script. Generate EXACTLY ${chunk.length} prompts, one per narration below, using the absolute scene index given.

OUTPUT FORMAT (strict JSON only, no markdown, no preamble)
{"prompts":[
  {"index": ${indexOffset}, "imagePrompt": "<one English sentence, 18-35 words>"},
  {"index": ${indexOffset + 1}, "imagePrompt": "..."}
]}

NARRATIONS (verbatim, fixed — do not modify):
${numberedNarrations}

FULL SCRIPT (context only):
${fullScript}`;
}

export async function splitScriptInto2sScenes(
  customScript: string,
  durationMinutes: number,
  kitImagePrompts: string[] = [],
  pilotSampleSize?: number,
  jobId?: string,
): Promise<ScriptResult> {
  const config = await getConfig();
  const modelId = PROMPT_MODEL;

  const totalDurS = Math.max(60, Math.round(durationMinutes * 60));

  // Step 1: deterministic JS segmentation — narration is VERBATIM, Claude cannot touch it.
  let segments = segmentScriptVerbatim(customScript);
  if (segments.length === 0) throw new Error("splitScriptInto2sScenes: aucun segment trouvé après découpage JS");

  // Hard cap on scene count. A 2s-per-scene split of a long script explodes to 600+ scenes,
  // which is unusable for a client (hundreds of image gens + a slideshow that drags). Cap at
  // MAX_SCENES by merging adjacent segments into balanced groups: narration is concatenated
  // VERBATIM (joined with " ", matching the divergence guard below) and durations summed — the
  // script itself is never rewritten, scenes just become a bit longer (~4-5s each).
  const MAX_SCENES = 275;
  if (segments.length > MAX_SCENES) {
    const total = segments.length;
    const merged: Array<{ narration: string; durationSeconds: number }> = [];
    for (let g = 0; g < MAX_SCENES; g++) {
      const start = Math.floor((g * total) / MAX_SCENES);
      const end = Math.max(Math.floor(((g + 1) * total) / MAX_SCENES), start + 1);
      const group = segments.slice(start, end);
      merged.push({
        narration: group.map((s) => s.narration).join(" "),
        durationSeconds: group.reduce((a, s) => a + s.durationSeconds, 0),
      });
    }
    console.log(`[Claude 2s Prompts] cap scènes: ${total} → ${merged.length} (max ${MAX_SCENES}, fusion segments adjacents, verbatim préservé)`);
    segments = merged;
  }

  // PILOT MODE: only generate imagePrompts for a spread-out subset of indices.
  // Non-pilot scenes get an empty imagePrompt — the pipeline's pilot filter drops them
  // before image gen. This keeps Claude work O(pilot_size) instead of O(segments.length),
  // which is both faster AND avoids the wrapper-VPS instability seen on long runs.
  // MUST match samplePilotIndices() in lib/pipeline/runner.ts — both functions need to
  // pick the same indices so the runner's pilotSet downstream matches the prompts we generated.
  const pilotIndices: number[] | null = (() => {
    if (!pilotSampleSize || pilotSampleSize <= 0) return null;
    const total = segments.length;
    const n = Math.max(1, Math.min(pilotSampleSize, total));
    if (n >= total) return null; // pilot >= script: nothing to skip, fall back to full processing
    const out = new Set<number>();
    for (let i = 0; i < n; i++) {
      out.add(n === 1 ? 0 : Math.round((i / (n - 1)) * (total - 1)));
    }
    for (let i = 0; out.size < n && i < total; i++) out.add(i);
    return [...out].sort((a, b) => a - b);
  })();

  // Step 2: Claude generates ONLY the imagePrompts for each (verbatim) narration, in order.
  // REMIX MODE: when a kit vocabulary is provided, Claude must PICK the most relevant kit prompt
  // for each narration and lightly remix it (swap objects/labels) instead of inventing from scratch.
  // This keeps the visual style anchored to the kit's existing reference frames.
  // FROM-SCRATCH MODE (no kit): falls back to the full STICKMAN_IMAGE_SYSTEM brief.
  //
  // CHUNKING: Claude reliably handles ~50 prompts per call. Past that the output JSON truncates
  // and the tail of the script comes back as fallback. We slice the segments into batches and
  // merge the results. A small overlap window helps narrative continuity.
  const useRemixMode = kitImagePrompts.length > 0;
  // Claude Code CLI (via the VPS wrapper) caps its output below the Anthropic API limit.
  // 20 prompts × ~200 tokens ≈ 4k tokens response — fits the CLI's default ceiling with margin.
  const CHUNK_SIZE = 20;
  // Retry passes get smaller chunks: a chunk that failed once was likely too big or
  // tripped a transient cap, so we re-ask in halves.
  const RETRY_CHUNK_SIZE = 10;
  const promptsByIdx = new Map<number, string>();
  const categoriesByIdx = new Map<number, SceneCategory>();

  // Forced category allocation: 10% STICK, 60% SETTING, 30% OBJECT with no two-in-a-row.
  const allocated = allocateCategories(segments.length);
  allocated.forEach((cat, i) => categoriesByIdx.set(i, cat));
  console.log(`[Claude 2s Prompts] catégories allouées — STICK: ${allocated.filter(c=>c==="STICK").length}, SETTING: ${allocated.filter(c=>c==="SETTING").length}, OBJECT: ${allocated.filter(c=>c==="OBJECT").length}`);

  // PILOT SHORTCUT: only generate imagePrompts for the pilot subset, single Claude call.
  // Avoids the cost AND avoids the wrapper-VPS instability seen on long chunked runs.
  if (pilotIndices) {
    console.log(`[Claude 2s Prompts] PILOT — ${pilotIndices.length} scènes sur ${segments.length} (indices ${pilotIndices.join(", ")})`);
    const slice = pilotIndices.map((idx) => segments[idx]);
    const localCats = new Map<number, SceneCategory>();
    pilotIndices.forEach((origIdx, localIdx) => localCats.set(localIdx, categoriesByIdx.get(origIdx) ?? "OBJECT"));
    const pilotPrompt = buildPrompt(useRemixMode, slice, 0, slice.length, kitImagePrompts, customScript, localCats);

    let pilotErr: Error | null = null;
    try {
      const response = await callClaudeRetry(
        modelId,
        Math.min(8000, 200 + slice.length * 400),
        [{ role: "user", content: pilotPrompt }],
        "Claude 2s Pilot",
      );
      const raw = (response.content[0]?.text || "").trim();
      const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const tryParse = (): Array<{ index?: number; imagePrompt?: string }> => {
        try {
          const parsed = JSON.parse(stripped) as { prompts?: Array<{ index?: number; imagePrompt?: string }> };
          return parsed.prompts ?? [];
        } catch {
          const re = /\{\s*"index"\s*:\s*(\d+)[\s\S]*?"imagePrompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
          const out: Array<{ index: number; imagePrompt: string }> = [];
          let m: RegExpExecArray | null;
          while ((m = re.exec(stripped)) !== null) {
            out.push({ index: parseInt(m[1], 10), imagePrompt: m[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim() });
          }
          return out;
        }
      };
      for (const p of tryParse()) {
        if (typeof p.index === "number" && typeof p.imagePrompt === "string" && p.imagePrompt.trim()) {
          const origIdx = pilotIndices[p.index];
          if (origIdx !== undefined) promptsByIdx.set(origIdx, p.imagePrompt.trim());
        }
      }
    } catch (err) {
      pilotErr = err as Error;
    }

    const missingPilot = pilotIndices.filter((i) => !promptsByIdx.has(i));
    if (missingPilot.length > 0) {
      throw new Error(`splitScriptInto2sScenes PILOT: ${missingPilot.length}/${pilotIndices.length} pilot prompts manquants (indices ${missingPilot.join(",")})${pilotErr ? ` — last error: ${pilotErr.message}` : ""}`);
    }

    const scenes: ScriptScene[] = segments.map((seg, i) => ({
      index: i,
      narration: seg.narration,
      imagePrompt: promptsByIdx.get(i) ?? "",
      durationSeconds: seg.durationSeconds,
    }));
    const fullScript = scenes.map((s) => s.narration).join(" ");
    console.log(`[Claude 2s Prompts] PILOT done — ${pilotIndices.length} prompts générés, ${segments.length - pilotIndices.length} scènes hors-pilot avec imagePrompt vide`);
    return { fullScript, scenes, wordCount: fullScript.split(/\s+/).filter(Boolean).length };
  }

  // Parse Claude output: strict JSON first, regex fallback if the JSON is truncated/malformed.
  // Returns count of prompts ingested + the raw length (so callers can log truncation).
  const ingestResponse = (raw: string): { got: number; rawLen: number; head: string; tail: string } => {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const head = stripped.slice(0, 120).replace(/\s+/g, " ");
    const tail = stripped.slice(-120).replace(/\s+/g, " ");
    let got = 0;
    try {
      const parsed = JSON.parse(stripped) as { prompts?: Array<{ index?: number; imagePrompt?: string }> };
      for (const p of parsed.prompts ?? []) {
        if (typeof p.index === "number" && typeof p.imagePrompt === "string" && p.imagePrompt.trim()) {
          promptsByIdx.set(p.index, p.imagePrompt.trim());
          got++;
        }
      }
      return { got, rawLen: stripped.length, head, tail };
    } catch {
      const re = /\{\s*"index"\s*:\s*(\d+)[\s\S]*?"imagePrompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        const idx = parseInt(m[1], 10);
        const text = m[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
        if (text) { promptsByIdx.set(idx, text); got++; }
      }
      return { got, rawLen: stripped.length, head, tail };
    }
  };

  const callChunk = async (startIdx: number, endIdx: number, chunkIndex: number): Promise<void> => {
    const chunk = segments.slice(startIdx, endIdx);
    const chunkPrompt = buildPrompt(useRemixMode, chunk, startIdx, segments.length, kitImagePrompts, customScript, categoriesByIdx);
    try {
      const response = await callClaudeRetry(
        modelId,
        Math.min(32000, 200 + chunk.length * 200), // generous: ~200 tokens per prompt
        [{ role: "user", content: chunkPrompt }],
        `Claude 2s Prompts [${startIdx}-${endIdx - 1}]`,
        { jobId, chunkIndex },
      );
      const raw = (response.content[0]?.text || "").trim();
      const r = ingestResponse(raw);
      if (r.got < chunk.length) {
        console.warn(`[Claude 2s Prompts] chunk [${startIdx}-${endIdx - 1}]: ${r.got}/${chunk.length} prompts — rawLen=${r.rawLen}, head="${r.head}", tail="${r.tail}"`);
      } else {
        console.log(`[Claude 2s Prompts] chunk [${startIdx}-${endIdx - 1}]: ${r.got}/${chunk.length} prompts`);
      }
    } catch (err) {
      console.warn(`[Claude 2s Prompts] chunk [${startIdx}-${endIdx - 1}] failed: ${(err as Error).message}`);
    }
  };

  // Generate chunks in parallel — they're independent (no cross-chunk state).
  const chunks: Array<[number, number]> = [];
  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    chunks.push([i, Math.min(i + CHUNK_SIZE, segments.length)]);
  }
  console.log(`[Claude 2s Prompts] ${segments.length} scènes → ${chunks.length} chunk(s) de max ${CHUNK_SIZE} (mode=${useRemixMode ? "remix" : "from-scratch"}, série)`);
  // Série stricte — wrapper VPS CPU-bound sur un seul process. Parallel = fetch failed en boucle.
  for (let i = 0; i < chunks.length; i++) {
    await callChunk(chunks[i][0], chunks[i][1], i);
  }

  // Up to 2 retry passes targeting only the still-missing indices. After that → ABORT (no
  // fallback prompts allowed; a generic placeholder would silently degrade the video).
  for (let retry = 1; retry <= 2; retry++) {
    const missing: number[] = [];
    for (let i = 0; i < segments.length; i++) if (!promptsByIdx.has(i)) missing.push(i);
    if (missing.length === 0) break;
    console.warn(`[Claude 2s Prompts] retry ${retry}/2 sur ${missing.length} index manquants: ${missing.slice(0, 10).join(",")}${missing.length > 10 ? "…" : ""}`);
    // Re-chunk the missing list using a SMALLER chunk size — the original failure was likely
    // an output cap, so we halve the request to give Claude more breathing room.
    const missingChunks: number[][] = [];
    for (let i = 0; i < missing.length; i += RETRY_CHUNK_SIZE) missingChunks.push(missing.slice(i, i + RETRY_CHUNK_SIZE));
    await Promise.all(missingChunks.map(async (origIdxs, retryChunkIndex) => {
      // Re-use callChunk semantics by building a synthetic segment slice that preserves indices.
      // We pass the actual absolute index range to buildPrompt via a small inline wrapper that
      // injects only the missing scenes into a per-index map override.
      const slice = origIdxs.map((idx) => segments[idx]);
      const localCats = new Map<number, SceneCategory>();
      origIdxs.forEach((origIdx, localIdx) => localCats.set(localIdx, categoriesByIdx.get(origIdx) ?? "OBJECT"));
      const retryPrompt = buildPrompt(useRemixMode, slice, 0, slice.length, kitImagePrompts, customScript, localCats);
      try {
        const response = await callClaudeRetry(
          modelId,
          Math.min(32000, 200 + slice.length * 200),
          [{ role: "user", content: retryPrompt }],
          `Claude 2s Prompts retry${retry}`,
          { jobId, chunkIndex: retryChunkIndex },
        );
        const raw = (response.content[0]?.text || "").trim();
        const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        // Custom ingestor: indices in the response are 0..N-1, remap to origIdxs[]
        const tryParse = () => {
          try {
            const parsed = JSON.parse(stripped) as { prompts?: Array<{ index?: number; imagePrompt?: string }> };
            return parsed.prompts ?? [];
          } catch {
            const re = /\{\s*"index"\s*:\s*(\d+)[\s\S]*?"imagePrompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            const out: Array<{ index: number; imagePrompt: string }> = [];
            let m: RegExpExecArray | null;
            while ((m = re.exec(stripped)) !== null) {
              out.push({ index: parseInt(m[1], 10), imagePrompt: m[2].replace(/\\"/g, '"').replace(/\\n/g, " ").trim() });
            }
            return out;
          }
        };
        for (const p of tryParse()) {
          if (typeof p.index === "number" && typeof p.imagePrompt === "string" && p.imagePrompt.trim()) {
            const origIdx = origIdxs[p.index];
            if (origIdx !== undefined) promptsByIdx.set(origIdx, p.imagePrompt.trim());
          }
        }
      } catch (err) {
        console.warn(`[Claude 2s Prompts] retry${retry} batch failed: ${(err as Error).message}`);
      }
    }));
  }

  const stillMissing: number[] = [];
  for (let i = 0; i < segments.length; i++) if (!promptsByIdx.has(i)) stillMissing.push(i);
  if (stillMissing.length > 0) {
    throw new Error(`splitScriptInto2sScenes: ${stillMissing.length} scène(s) sans imagePrompt après retries (indices: ${stillMissing.slice(0, 20).join(",")}${stillMissing.length > 20 ? "…" : ""}). ABORT (pas de fallback générique autorisé).`);
  }

  const scenes: ScriptScene[] = segments.map((seg, i) => ({
    index: i,
    narration: seg.narration,
    imagePrompt: promptsByIdx.get(i)!,
    durationSeconds: seg.durationSeconds,
  }));

  // Hard validation: concatenated narrations MUST equal the original script (whitespace normalized).
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const reconstructed = norm(scenes.map((s) => s.narration).join(" "));
  const original = norm(customScript);
  if (reconstructed !== original) {
    const i = [...reconstructed].findIndex((c, k) => c !== original[k]);
    throw new Error(`splitScriptInto2sScenes: narration diverge du script original au char ${i}. orig="${original.slice(Math.max(0, i - 30), i + 30)}" rec="${reconstructed.slice(Math.max(0, i - 30), i + 30)}"`);
  }

  const fullScript = scenes.map((s) => s.narration).join(" ");
  const totalOut = scenes.reduce((acc, s) => acc + s.durationSeconds, 0);
  const avg = totalOut / Math.max(1, scenes.length);
  console.log(`[Claude 2s Prompts] ${scenes.length} scènes verbatim (total ${totalOut.toFixed(1)}s / cible ${totalDurS}s, avg ${avg.toFixed(2)}s/scène) NO FALLBACK`);
  return { fullScript, scenes, wordCount: fullScript.split(/\s+/).filter(Boolean).length };
}

export async function generateScript2sScenes(
  title: string,
  niche: string,
  brief: string,
  durationMinutes: number,
  /** "en" | "fr" | "Français" | "English" | bcp voix code (e.g. "male-fr") — kept loose for callers. */
  languageOrVoix: string,
  kitImagePrompts: string[] = [],
): Promise<ScriptResult> {
  const config = await getConfig();
  const modelId = PROMPT_MODEL;

  const totalDurS = Math.max(60, Math.round(durationMinutes * 60));
  const targetScenes = Math.round(totalDurS / 1.5); // 1.5s par scène en moyenne
  const targetWords = Math.round(durationMinutes * 165); // ~165 wpm stickman pace
  const lc = languageOrVoix.toLowerCase();
  const language = lc === "fr" || lc.includes("français") || lc.includes("francais") || lc.includes("-fr") ? "Français" : "English";

  const prompt = `Tu écris un script YouTube stickman explainer (style Sam-O-Nella / AfterSkool) sur le sujet "${title}" dans la niche "${niche}".
${brief ? `Brief : ${brief}\n` : ""}Langue narration : ${language}.
Durée : ${durationMinutes} minutes (${totalDurS}s) → ~${targetScenes} scènes ultra-courtes (1.5s en moyenne, 2s grand max).

${ADAPTIVE_DURATION_RULES}

Règles narration :
- 2-6 mots par scène, en ${language}, rythme stickman explainer ultra rapide.
- Une idée par scène. Une virgule = nouvelle scène. Une sous-phrase ("when X", "but Y") = nouvelle scène.
- Ton direct, parfois drôle, storytelling éducatif punchy. Pas de digressions, jamais de phrases qui s'étalent.
- Hook fort dès la première scène (≤1.5s), narrative tendue, intensité maintenue tout du long.
- Cible totale : ~${targetWords} mots de narration distribués sur ~${targetScenes} scènes (≈ 4 mots/scène).

${TWO_SEC_IMAGE_PROMPT_RULES}
${buildVocabBlock(kitImagePrompts)}

Pour chaque scène :
{
  "index": <0-based>,
  "narration": "<2-6 mots ${language}>",
  "imagePrompt": "<phrase anglaise selon le format>",
  "durationSeconds": <1 | 1.5 | 2>
}

Réponds avec UN bloc JSON strict, pas de markdown, pas de préambule. La somme des durationSeconds doit approcher ${totalDurS}s (±10%) :
{"scenes":[ ... ]}`;

  const response = await callClaudeRetry(
    modelId,
    32000,
    [{ role: "user", content: prompt }],
    "Claude 2s Generate",
  );
  const raw = (response.content[0]?.text || "").trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: { scenes?: Array<{ index?: number; narration?: string; imagePrompt?: string; durationSeconds?: number }> };
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`generateScript2sScenes: JSON invalide — ${(err as Error).message}. Début: ${stripped.slice(0, 200)}`);
  }
  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const allowed = new Set([1, 1.5, 2]);
  const scenes: ScriptScene[] = rawScenes
    .filter((s) => typeof s.narration === "string" && typeof s.imagePrompt === "string")
    .map((s, i) => {
      const d = typeof s.durationSeconds === "number" ? s.durationSeconds : 1.5;
      return {
        index: typeof s.index === "number" ? s.index : i,
        narration: (s.narration as string).trim(),
        imagePrompt: (s.imagePrompt as string).trim(),
        durationSeconds: allowed.has(d) ? d : Math.min(2, Math.max(1, d)),
      };
    });
  if (scenes.length === 0) throw new Error("generateScript2sScenes: aucune scène exploitable");
  const fullScript = scenes.map((s) => s.narration).join(" ");
  const totalOut = scenes.reduce((acc, s) => acc + s.durationSeconds, 0);
  const avg = totalOut / Math.max(1, scenes.length);
  console.log(`[Claude 2s Generate] ${scenes.length} scènes (total ${totalOut.toFixed(1)}s / cible ${totalDurS}s, avg ${avg.toFixed(2)}s/scène)`);
  return { fullScript, scenes, wordCount: fullScript.split(/\s+/).filter(Boolean).length };
}
