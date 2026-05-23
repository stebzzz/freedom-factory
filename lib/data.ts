import { PipelineStep, Scenario, PricingComparison } from "./types";

export const pipelineSteps: PipelineStep[] = [
  {
    id: 1,
    name: "Script",
    tool: "Claude Opus 4.6",
    icon: "FileText",
    description: "Generation AIDA, hooks, structure narrative",
    costEstimate: "~$0.015/1K tokens",
    status: "waiting",
    progress: 0,
  },
  {
    id: 2,
    name: "Voiceover",
    tool: "Fish Speech 1.5",
    icon: "Mic",
    description: "Synthese vocale ultra-realiste via SiliconFlow",
    costEstimate: "~$0.06/1K chars",
    status: "waiting",
    progress: 0,
  },
  {
    id: 3,
    name: "Images principales",
    tool: "GenAIPro Veo",
    icon: "Image",
    description: "Scenes cinematiques, paysages, ambiance",
    costEstimate: "$0.03/megapixel",
    status: "waiting",
    progress: 0,
  },
  {
    id: 4,
    name: "Images premium",
    tool: "GenAIPro Veo (premium)",
    icon: "Sparkles",
    description: "Photorealisme, personnages, scenes cles",
    costEstimate: "~$0.04-0.05/img",
    status: "waiting",
    progress: 0,
  },
  {
    id: 5,
    name: "Thumbnails",
    tool: "GenAIPro Veo",
    icon: "LayoutGrid",
    description: "Vignettes esthetiques, 16:9 haute qualite",
    costEstimate: "$0.03/megapixel",
    status: "waiting",
    progress: 0,
  },
  {
    id: 6,
    name: "Images bulk",
    tool: "GenAIPro Veo (bulk)",
    icon: "Images",
    description: "B-roll, transitions, remplissage visuel",
    costEstimate: "$0.02/image",
    status: "waiting",
    progress: 0,
  },
  {
    id: 7,
    name: "Animation I2V",
    tool: "GenAIPro Veo3 (T2V / I2V / Ingredients)",
    icon: "Clapperboard",
    description: "Animation d'images statiques en clips video",
    costEstimate: "~$0.05/clip",
    status: "waiting",
    progress: 0,
  },
  {
    id: 8,
    name: "Musique",
    tool: "Suno / Mubert",
    icon: "Music",
    description: "Musique de fond generee par IA",
    costEstimate: "~$0.01/min",
    status: "waiting",
    progress: 0,
  },
  {
    id: 9,
    name: "Montage",
    tool: "FFmpeg + Ken Burns",
    icon: "Film",
    description: "Assemblage audio + images + sous-titres SRT",
    costEstimate: "Gratuit",
    status: "waiting",
    progress: 0,
  },
];

export const scenarioA: Scenario = {
  name: "A",
  label: "Stack optimal",
  totalMin: 108,
  totalMax: 118,
  costPerVideo: "~$10-12",
  items: [
    { poste: "Script",         outil: "Claude Opus 4.6 API",      volume: "~10 scripts",    coutMois: "~$15-25",  amount: 20 },
    { poste: "Voiceover",      outil: "Fish Speech 1.5 (SiliconFlow)", volume: "10 x 10 min", coutMois: "~$12",   amount: 12 },
    { poste: "Images princ.",  outil: "GenAIPro Veo",             volume: "~1,500 img",     coutMois: "~$45",     amount: 45 },
    { poste: "Images prem.",   outil: "GenAIPro Veo (premium)",   volume: "~200 img",       coutMois: "~$10",     amount: 10 },
    { poste: "Thumbnails",     outil: "GenAIPro Veo",             volume: "~30 var.",       coutMois: "~$5",      amount: 5 },
    { poste: "Images bulk",    outil: "GenAIPro Veo (bulk)",      volume: "~300 img",       coutMois: "~$6",      amount: 6 },
    { poste: "Animation",      outil: "GenAIPro Veo3",            volume: "~50 clips",      coutMois: "~$5",      amount: 5 },
  ],
};

export const scenarioB: Scenario = {
  name: "B",
  label: "Ultra budget",
  totalMin: 60,
  totalMax: 70,
  costPerVideo: "~$7",
  items: [
    { poste: "Script",        outil: "Claude Sonnet 4.6",        volume: "",  coutMois: "~$5-10",  amount: 7.5 },
    { poste: "Voiceover",     outil: "Fish Speech 1.5",          volume: "",  coutMois: "~$8",     amount: 8 },
    { poste: "Toutes images", outil: "GenAIPro Veo (bulk)",      volume: "",  coutMois: "~$40",    amount: 40 },
    { poste: "Thumbnails",    outil: "GenAIPro Veo",             volume: "",  coutMois: "$0",      amount: 0 },
  ],
};

export const pricingFalai: PricingComparison[] = [
  { modele: "Veo image (nano_banana_pro)",  prixFalai: "via GenAIPro",   prixOfficiel: "—",   economie: "—" },
  { modele: "Veo3 text-to-video",           prixFalai: "via GenAIPro",   prixOfficiel: "—",   economie: "—" },
  { modele: "Veo frames-to-video (I2V)",    prixFalai: "via GenAIPro",   prixOfficiel: "—",   economie: "—" },
  { modele: "Veo ingredients-to-video",     prixFalai: "via GenAIPro",   prixOfficiel: "—",   economie: "—" },
];

export const budgetChartData = [
  { name: "Script",     optimal: 20,  budget: 7.5 },
  { name: "Voiceover",  optimal: 12,  budget: 8 },
  { name: "Images",     optimal: 45,  budget: 40 },
  { name: "Premium",    optimal: 10,  budget: 0 },
  { name: "Thumbs",     optimal: 5,   budget: 0 },
  { name: "Bulk",       optimal: 6,   budget: 0 },
  { name: "Animation",  optimal: 5,   budget: 0 },
];

export const projectionData = [
  { month: "Mois 1", optimal: 108, budget: 62, videos: 10 },
  { month: "Mois 2", optimal: 103, budget: 60, videos: 10 },
  { month: "Mois 3", optimal: 100, budget: 58, videos: 12 },
];
