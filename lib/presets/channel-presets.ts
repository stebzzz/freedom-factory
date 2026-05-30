// ===================================================================
// Channel Presets — creative DNA for each channel type
// ===================================================================

export interface ChannelPreset {
  id: string;
  label: string;
  emoji: string;
  description: string;
  language: "fr" | "en";

  // Script generation
  script: {
    wordsPerMinute: number;
    scenesPerMinute: number;
    sceneDurationRange: [number, number]; // [min, max] seconds
    structure: "one-sentence" | "prose" | "numbered-list" | "dramatic-arc";
    claudeStylePrompt: string; // Injected into Claude prompt
    maxScenesPerChunk: number; // For chunked long-video generation
  };

  // Visual style
  visual: {
    imageStyleSuffix: string; // Appended to EVERY image prompt
    kenBurnsSpeed: number; // Zoom range: 0.06 (slow) to 0.18 (fast)
    transitionType: "crossfade" | "hard-cut" | "dip-to-black";
    transitionDuration: number; // seconds
    brollEnabled: boolean;
    archiveDensity: "all" | "alternate" | "sparse" | "none";
  };

  // Audio
  audio: {
    voiceSpeed: number; // 0.85 = slow, 1.0 = normal, 1.15 = fast
    musicGenre: string;
    musicVolume: number; // 0.0-1.0
  };

  // Subtitles
  subtitles: {
    style: "word-highlight" | "static" | "none";
    fontSize: number;
    position: "bottom" | "center-bottom";
  };

  // Duration bounds
  durationRange: {
    min: number; // minutes
    max: number;
    default: number;
  };
}

// -------------------------------------------------------------------
// PRESET: Sleepy / Relaxing
// Sleepy Time History, Sleepy Science, etc.
// -------------------------------------------------------------------
export const PRESET_SLEEPY: ChannelPreset = {
  id: "sleepy",
  label: "Sleepy / Relaxant",
  emoji: "😴",
  description: "Vidéos longues et apaisantes pour s'endormir. Voix calme, transitions douces, rythme lent.",
  language: "fr",
  script: {
    wordsPerMinute: 120,
    scenesPerMinute: 3,
    sceneDurationRange: [15, 30],
    structure: "prose",
    claudeStylePrompt: `Style SLEEPY/RELAXANT pour vidéo de sommeil.
REGLES :
- Ecris en prose longue et fluide, avec des phrases amples et apaisantes.
- Chaque scene = un paragraphe de 2-4 phrases, narration calme et continue.
- PAS de questions rhétoriques, PAS de hooks agressifs, PAS d'appels à l'action.
- Transitions douces entre les idées : "Pendant ce temps...", "Plus loin...", "Au fil des siècles...".
- Ton: contemplatif, doux, comme un conteur au coin du feu qui murmure.
- Vocabulaire riche mais pas complexe, phrases longues avec des virgules.
- Éviter les mots excitants (incroyable, choquant, fou). Préférer (fascinant, paisible, remarquable).`,
    maxScenesPerChunk: 30,
  },
  visual: {
    imageStyleSuffix: "hand-drawn watercolor illustration style, soft ink outlines, delicate washes of muted warm earth tones, dreamy atmospheric perspective, vintage storybook aesthetic, gentle color palette, serene and peaceful mood, 16:9",
    kenBurnsSpeed: 0.04,
    transitionType: "crossfade",
    transitionDuration: 2.0,
    brollEnabled: true,
    archiveDensity: "sparse",
  },
  audio: {
    voiceSpeed: 0.85,
    musicGenre: "ambient drone, soft piano, nature sounds",
    musicVolume: 0.25,
  },
  subtitles: {
    style: "none",
    fontSize: 48,
    position: "bottom",
  },
  durationRange: { min: 15, max: 180, default: 60 },
};

// -------------------------------------------------------------------
// PRESET: Documentary FR
// Tim Reborn History
// -------------------------------------------------------------------
export const PRESET_DOCUMENTARY_FR: ChannelPreset = {
  id: "documentary-fr",
  label: "Documentaire FR",
  emoji: "🎬",
  description: "Documentaires historiques/scientifiques en français. Voix narrative, images cinématiques.",
  language: "fr",
  script: {
    wordsPerMinute: 150,
    scenesPerMinute: 6,
    sceneDurationRange: [7, 15],
    structure: "one-sentence",
    claudeStylePrompt: `Style DOCUMENTAIRE FRANÇAIS, comme une narration Arte/France 5.
REGLES :
- UNE PHRASE = UNE SCENE = UNE IMAGE. Chaque scene contient 1-2 phrases max.
- Ton autoritaire mais accessible, vocabulaire riche et précis.
- Rythme soutenu avec des faits historiques/scientifiques vérifiables.
- Structure narrative avec fil conducteur clair.
- Transitions : "Mais ce n'est que le début...", "Ce que personne ne sait...", "La suite va tout changer...".
- Commence par un hook factuel saisissant. Termine par une ouverture.`,
    maxScenesPerChunk: 40,
  },
  visual: {
    imageStyleSuffix: "cinematic documentary photography, dramatic lighting, rich colors, historical accuracy, photorealistic, 8k, 16:9",
    kenBurnsSpeed: 0.12,
    transitionType: "crossfade",
    transitionDuration: 0.8,
    brollEnabled: true,
    archiveDensity: "alternate",
  },
  audio: {
    voiceSpeed: 1.0,
    musicGenre: "cinematic orchestral, dramatic strings",
    musicVolume: 0.12,
  },
  subtitles: {
    style: "word-highlight",
    fontSize: 56,
    position: "center-bottom",
  },
  durationRange: { min: 5, max: 60, default: 15 },
};

// -------------------------------------------------------------------
// PRESET: Ranking / Top X
// Mr. Ranks
// -------------------------------------------------------------------
export const PRESET_RANKING: ChannelPreset = {
  id: "ranking",
  label: "Ranking / Top X",
  emoji: "🏆",
  description: "Top 10/20/50 avec voix énergique, coupes rapides et format numéroté.",
  language: "fr",
  script: {
    wordsPerMinute: 170,
    scenesPerMinute: 10,
    sceneDurationRange: [4, 8],
    structure: "numbered-list",
    claudeStylePrompt: `Style RANKING / TOP X, comme les chaînes Mr. Ranks ou Lama Faché.
REGLES :
- Format LISTE NUMÉROTÉE : "Numéro 10 :", "Numéro 9 :", etc. (du plus bas au plus haut).
- Chaque entrée = 1-2 phrases percutantes + 1 fait surprenant.
- UNE PHRASE = UNE SCENE. Rythme RAPIDE, coupes visuelles fréquentes.
- Ton : énergique, excité, superlatifs ("le plus incroyable", "vous n'allez pas en croire vos yeux").
- Transitions entre numéros : "Mais attendez de voir le numéro suivant...", "Et ça ne fait que commencer...".
- HOOK ultra-accrocheur en intro. Tease le numéro 1 au début.
- CTA d'abonnement à la fin.`,
    maxScenesPerChunk: 50,
  },
  visual: {
    imageStyleSuffix: "vibrant high contrast colors, dynamic composition, bold dramatic lighting, ultra sharp, professional photography, 8k, 16:9",
    kenBurnsSpeed: 0.18,
    transitionType: "hard-cut",
    transitionDuration: 0,
    brollEnabled: true,
    archiveDensity: "sparse",
  },
  audio: {
    voiceSpeed: 1.1,
    musicGenre: "electronic upbeat, energetic background",
    musicVolume: 0.10,
  },
  subtitles: {
    style: "word-highlight",
    fontSize: 64,
    position: "center-bottom",
  },
  durationRange: { min: 5, max: 45, default: 15 },
};

// -------------------------------------------------------------------
// PRESET: Mystery / Unexplained
// Nexume
// -------------------------------------------------------------------
export const PRESET_MYSTERY: ChannelPreset = {
  id: "mystery",
  label: "Mystère / Inexpliqué",
  emoji: "🔮",
  description: "Mystères, enquêtes, phénomènes inexpliqués. Voix dramatique, visuels sombres.",
  language: "fr",
  script: {
    wordsPerMinute: 140,
    scenesPerMinute: 7,
    sceneDurationRange: [6, 12],
    structure: "dramatic-arc",
    claudeStylePrompt: `Style MYSTÈRE / INEXPLIQUÉ, comme Nexume ou Squeezie Enquêtes.
REGLES :
- Narration DRAMATIQUE avec montée en tension progressive.
- Chaque scene = 1-2 phrases. Alterner faits et questionnements.
- Finir certaines scenes par des cliffhangers : "Mais ce qu'ils ont découvert ensuite...", "Personne ne peut expliquer ce qui s'est passé après...".
- Ton : grave, mystérieux, presque murmuré par moments.
- Questions rhétoriques pour impliquer le spectateur : "Et si je vous disais que...", "Vous pensez savoir ce qui s'est passé ?".
- Vocabulaire sombre : obscur, inexpliqué, terrifiant, mystérieux, troublant.
- Révéler l'information petit à petit, comme un puzzle.`,
    maxScenesPerChunk: 40,
  },
  visual: {
    imageStyleSuffix: "dark moody atmosphere, desaturated colors, noir cinematography, deep shadows, mysterious fog, ominous lighting, photorealistic, 8k, 16:9",
    kenBurnsSpeed: 0.10,
    transitionType: "dip-to-black",
    transitionDuration: 1.2,
    brollEnabled: true,
    archiveDensity: "alternate",
  },
  audio: {
    voiceSpeed: 0.95,
    musicGenre: "dark ambient, suspenseful tension, horror drone",
    musicVolume: 0.18,
  },
  subtitles: {
    style: "word-highlight",
    fontSize: 56,
    position: "center-bottom",
  },
  durationRange: { min: 8, max: 45, default: 20 },
};

// -------------------------------------------------------------------
// PRESET: White Face / Mannequin (la trend actuelle)
// Personnages en costumes avec visages blancs lisses sans traits
// -------------------------------------------------------------------
export const PRESET_WHITE_FACE: ChannelPreset = {
  id: "white-face",
  label: "Visage Blanc / Mannequin",
  emoji: "🤍",
  description: "Personnages mannequins avec visages blancs lisses. Style luxe, lifestyle, motivation.",
  language: "fr",
  script: {
    wordsPerMinute: 155,
    scenesPerMinute: 8,
    sceneDurationRange: [5, 10],
    structure: "one-sentence",
    claudeStylePrompt: `Style VISAGE BLANC / MANNEQUIN LUXE pour vidéo virale.
REGLES :
- UNE PHRASE = UNE SCENE = UNE IMAGE.
- Ton : motivationnel, puissant, phrases courtes et percutantes.
- Thèmes : richesse, succès, mentalité de gagnant, habitudes des millionnaires, lifestyle luxe.
- Style narratif direct, comme si tu parlais à quelqu'un en face : "Tu veux savoir...", "La plupart des gens ne comprennent pas...".
- Phrases à impact : chaque phrase doit pouvoir être un post Instagram.
- IMPORTANT pour les imagePrompts : TOUJOURS inclure des personnages humanoïdes en costumes/tenues élégantes dans des décors luxueux. Les personnages sont TOUJOURS présents dans chaque scène.`,
    maxScenesPerChunk: 50,
  },
  visual: {
    imageStyleSuffix: "featuring elegant humanoid mannequin figures with smooth blank white featureless faces, no eyes no nose no mouth, wearing expensive designer suits and luxury clothing, in ultra-luxurious settings, golden hour lighting, cinematic depth of field, hyper-realistic 3D render style, 8k, 16:9",
    kenBurnsSpeed: 0.14,
    transitionType: "hard-cut",
    transitionDuration: 0,
    brollEnabled: true,
    archiveDensity: "none",
  },
  audio: {
    voiceSpeed: 1.05,
    musicGenre: "motivational cinematic, epic orchestral, power music",
    musicVolume: 0.15,
  },
  subtitles: {
    style: "word-highlight",
    fontSize: 64,
    position: "center-bottom",
  },
  durationRange: { min: 3, max: 30, default: 10 },
};

// -------------------------------------------------------------------
// PRESET: Alphonse / Storytime perso uploadé (universel)
// 2D cel-shading "livre pour enfants", visages ronds blancs (style maison).
// L'IDENTITÉ du perso central vient de l'image @ uploadée (FlowMax) — PAS hardcodée
// ici → universel, marche pour n'importe quelle niche / n'importe quel "bonhomme".
// Conçu pour : script custom verbatim + images FlowMax (@ref) + anim Seedance.
// imageStyleSuffix = fallback (ignoré quand customScriptHasImagePrompts=true).
// PAS de "|" dans le suffix : casserait le parse styleName de FlowMax.
// -------------------------------------------------------------------
export const PRESET_ALPHONSE: ChannelPreset = {
  id: "alphonse",
  label: "Alphonse / Storytime perso uploadé",
  emoji: "🎭",
  description: "Storytime 2e personne. Le perso central est UPLOADÉ (réf FlowMax @) → universel. Style 2D cartoon doux, images FlowMax + animation Seedance.",
  language: "en",
  script: {
    wordsPerMinute: 130,
    scenesPerMinute: 7,
    sceneDurationRange: [4, 8],
    structure: "dramatic-arc",
    claudeStylePrompt: `Immersive STORYTIME, 2nd person ("You are ...").
RULES:
- Slow, grave, intimate narration with rising tension.
- Each scene = 1-2 sentences, concrete and visceral.
- If the arc spans ages/chapters, keep the progression explicit.
- NOTE: this channel normally runs on a verbatim custom script — do NOT rewrite when one is provided.`,
    maxScenesPerChunk: 40,
  },
  visual: {
    // Style maison générique. L'identité du perso vient de l'image @ uploadée (FlowMax),
    // donc on ne décrit PAS un personnage précis ici.
    imageStyleSuffix: "children's picture book storytime animation, clean 2D cel-shading, bold thick uniform black outlines, flat simple colors, every human face is a pure white round featureless face with only two tiny black dot eyes and one thin mouth line (no nose, no skin tone, no realistic features), soft and gentle look, cinematic 16:9, NOT photorealistic, NOT 3D, NOT anime",
    kenBurnsSpeed: 0.08,
    transitionType: "dip-to-black",
    transitionDuration: 1.0,
    brollEnabled: false,
    archiveDensity: "none",
  },
  audio: {
    voiceSpeed: 0.95,
    musicGenre: "melancholic cinematic ambient, slow sorrowful strings, sparse",
    musicVolume: 0.16,
  },
  subtitles: {
    style: "none",
    fontSize: 56,
    position: "center-bottom",
  },
  durationRange: { min: 5, max: 45, default: 20 },
};

// -------------------------------------------------------------------
// All presets
// -------------------------------------------------------------------
// -------------------------------------------------------------------
// PRESET: Sticky — stickman cartoon explainer (Sam-O-Nella / AfterSkool)
// 1 plan toutes les 2s, style stick figure, refs uploadees lockent la DA.
// -------------------------------------------------------------------
export const PRESET_STICKY: ChannelPreset = {
  id: "sticky",
  label: "Sticky (stickman explainer)",
  emoji: "✏️",
  description: "Cartoon stickman façon Sam-O-Nella / AfterSkool. 1 image statique toutes les 2s (mode 'Static images' recommandé). Upload tes refs pour locker la DA.",
  language: "fr",
  script: {
    wordsPerMinute: 165,
    scenesPerMinute: 30,
    sceneDurationRange: [2, 2],
    structure: "one-sentence",
    claudeStylePrompt: `Style STICKMAN CARTOON EXPLAINER, comme Sam-O-Nella ou AfterSkool.
REGLES :
- UN GROUPE COURT DE MOTS = UNE SCENE = UNE IMAGE = 2 SECONDES PILE.
- Chaque scene ne contient que 5-10 mots (1 phrase tres courte ou un fragment de phrase). On peut couper une phrase longue en plusieurs scenes.
- Rythme rapide, coupes visuelles toutes les 2 secondes — chaque coupe doit apporter un nouveau visuel ou une nouvelle idee.
- Ton : direct, parfois drole, storytelling educatif punchy.
- Chaque narration doit etre VISUALISABLE en un dessin simple : un personnage stickman qui fait une action, un objet, une metaphore visuelle minimaliste.
- Privilegier verbes d'action concrets + sujets dessinables au trait. Eviter les phrases abstraites sans visuel.
- Pas de digressions, pas de phrases qui s'etalent.`,
    maxScenesPerChunk: 60,
  },
  visual: {
    imageStyleSuffix: "minimalist stickman cartoon illustration, thick bold black outlines, simple stick figures with round heads and dot eyes, flat solid colored backgrounds, hand-drawn whiteboard explainer aesthetic, no shading, no gradients, expressive simple cartoon poses, 16:9",
    kenBurnsSpeed: 0.05,
    transitionType: "hard-cut",
    transitionDuration: 0,
    brollEnabled: false,
    archiveDensity: "none",
  },
  audio: {
    voiceSpeed: 1.1,
    musicGenre: "lighthearted acoustic, playful upbeat background",
    musicVolume: 0.12,
  },
  subtitles: {
    style: "word-highlight",
    fontSize: 56,
    position: "center-bottom",
  },
  durationRange: { min: 2, max: 30, default: 8 },
};

// -------------------------------------------------------------------
// PRESET: Auto — Claude libre, pas de cadre rigide
// Le runner détecte ce preset et bypasse l'injection style/visual.
// Claude génère script + ton + visuels à partir du seul titre + niche.
// -------------------------------------------------------------------
export const PRESET_AUTO: ChannelPreset = {
  id: "auto",
  label: "Auto — Claude décide",
  emoji: "✨",
  description: "Pas de style figé. Claude analyse ton titre et choisit ton, rythme et visuel adaptés.",
  language: "fr",
  script: {
    wordsPerMinute: 150,
    scenesPerMinute: 5,
    sceneDurationRange: [6, 18],
    structure: "one-sentence",
    claudeStylePrompt: "",
    maxScenesPerChunk: 40,
  },
  visual: {
    imageStyleSuffix: "",
    kenBurnsSpeed: 0.12,
    transitionType: "crossfade",
    transitionDuration: 0.7,
    brollEnabled: true,
    archiveDensity: "alternate",
  },
  audio: {
    voiceSpeed: 1.0,
    musicGenre: "",
    musicVolume: 0.12,
  },
  subtitles: {
    style: "word-highlight",
    fontSize: 56,
    position: "center-bottom",
  },
  durationRange: { min: 3, max: 60, default: 10 },
};

export const ALL_PRESETS: ChannelPreset[] = [
  PRESET_AUTO,
  PRESET_STICKY,
  PRESET_WHITE_FACE,
  PRESET_RANKING,
  PRESET_DOCUMENTARY_FR,
  PRESET_MYSTERY,
  PRESET_SLEEPY,
  PRESET_ALPHONSE,
];

export function getPreset(id: string): ChannelPreset | undefined {
  return ALL_PRESETS.find((p) => p.id === id);
}

export function getPresetOrDefault(id?: string): ChannelPreset {
  return (id ? getPreset(id) : undefined) || PRESET_DOCUMENTARY_FR;
}

// Async-aware helpers that include custom presets are in:
// @/lib/presets/custom-presets-store
// Import from there directly to avoid circular dependencies.
