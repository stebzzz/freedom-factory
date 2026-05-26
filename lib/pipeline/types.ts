export type PipelineJobStatus = "queued" | "running" | "completed" | "failed";

export type PipelineStepName =
  | "script"
  | "voiceover"
  | "images"
  | "premium"
  | "bulk"
  | "archives"
  | "animation"
  | "music"
  | "thumbnails"
  | "montage";

export interface PipelineJobParams {
  title: string;
  niche: string;
  description: string;
  voix: string;
  duration: number; // minutes
  scenario: "A" | "B";
  presetId?: string; // channel preset (sleepy, ranking, mystery, etc.)
  customScript?: string; // user-provided script text — skip Claude generation, parse into scenes
  customScriptHasImagePrompts?: boolean; // when true, the customScript already contains image prompts; extract them verbatim instead of regenerating
  parsedScenes?: ScriptScene[]; // pre-parsed scenes — skip Claude entirely
  enabledSteps?: Record<string, boolean>;
  videoMode?: "t2v" | "i2v" | "ingredients" | "static-images"; // route animation step. static-images = no Veo clip, images only + Ken Burns in montage.
  userRefImagePaths?: string[]; // ingredients mode: user-uploaded reference images injected into every scene
  styleKitSlug?: string; // legacy single-kit: used for both human and object scenes when the two slugs below are empty.
  styleKitHumanSlug?: string; // when set, scenes whose imagePrompt mentions a human/stickman pull ALL refs + styleBrief from THIS kit.
  styleKitObjectSlug?: string; // when set, scenes WITHOUT a human pull ALL refs + styleBrief from THIS kit.
  customStyle?: string; // free-text style description that OVERRIDES preset.visual.imageStyleSuffix when set
  voiceoverEnabled?: boolean; // explicit OFF skips the ElevenLabs step entirely (defaults to true via enabledSteps logic)
  muteClipAudio?: boolean; // when true, the montage step strips audio from Veo3 clips (keep only voiceover + music)
  pilotMode?: boolean; // run a 5-scene pilot (images + clips only, no voiceover/music/montage) for visual QA
  pilotSampleSize?: number; // override default pilot size (defaults to 5)
  resumeFromPilotId?: string; // reuse images + clips from a finished pilot job; skip those scenes in the new full run
  subtitlesEnabled?: boolean; // explicit OFF skips burned-in ASS subtitles in the montage
  alignWithWhisper?: boolean; // run whisper-cli on the voiceover to align scene durations with real audio (default true)
  competitorVideoUrl?: string; // YouTube URL of a video to replicate (transcript + thumbnail). Optional.
  rewriteCompetitorScript?: boolean; // when true and competitorVideoUrl is set, fetch the transcript, rewrite ~20% via Claude, use as customScript.
  /** When a describe-mode style kit is selected, controls the 2s-scenes script source.
   *  "auto" (default) = Claude writes script + splits into 2s scenes.
   *  "custom" = pipeline expects params.customScript and splits it into 2s scenes. */
  describeKitScriptSource?: "auto" | "custom";
  /** Which API generates the per-scene images.
   *  "genaipro" (default) = GenAIPro Veo (existing behavior).
   *  "geminigen"          = GeminiGen.AI (nano-banana-2 by default).
   *  "wan"                = Alibaba DashScope WAN 2.7 (Beijing region). */
  imageProvider?: "genaipro" | "geminigen" | "wan";
  /** Optional override for the geminigen model. Ignored when imageProvider != "geminigen". */
  geminigenModel?: "nano-banana-pro" | "nano-banana-2" | "imagen-4";
  /** Optional override for the WAN model. Ignored when imageProvider != "wan". */
  wanModel?: "wan2.7-image" | "wan2.7-image-pro";
  /** Which API generates the per-scene animation clips (I2V mode only).
   *  "genaipro" (default) = GenAIPro Veo3 I2V.
   *  "wan"                = Alibaba DashScope wan-i2v.
   *  T2V and Ingredients modes always use Veo3 — a `wan` selection falls back to Veo3 there with a warning. */
  animationProvider?: "genaipro" | "wan";
  /** Optional override for the WAN I2V model. Ignored when animationProvider != "wan". */
  wanI2VModel?: "wan2.2-i2v-flash" | "wan2.2-i2v-plus" | "wanx2.1-i2v-turbo" | "wanx2.1-i2v-plus";
  /** Per-job override of the global voiceModel setting (lib/config.ts). When set, takes precedence. */
  voiceModel?: "genaipro" | "elevenlabs" | "fishspeech";
  /** Optional GenAIPro Labs TTS model. Ignored when voiceModel != "genaipro". */
  genaiproTTSModel?: "eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_flash_v2_5" | "eleven_v3";
  /** TTS-native voice speed. Range 0.7–1.2 (ElevenLabs/GenAIPro hard limit). Default 1. */
  voiceSpeed?: number;
  /** Post-TTS ffmpeg atempo factor on the WAV (applied before Whisper alignment). Range 0.5–2.0. Default 1. */
  audioSpeed?: number;
  /** When true, the pipeline pauses after voiceover and waits for an explicit decision before generating images. */
  voiceoverGate?: boolean;
  /** When true, the pipeline runs ONLY the script step (segmentation + imagePrompts via Claude) then stops. */
  scriptOnly?: boolean;
  /** ChannelFlow integration: id of the source video in ChannelFlow's Firestore.
   *  When set, the runner writes the result back (status, video file, thumbnail) on completion. */
  channelflowVideoId?: string;
  /** ChannelFlow integration: id of the source channel (informational / logging). */
  channelflowChannelId?: string;
}

export interface ScriptScene {
  index: number;
  narration: string;
  imagePrompt: string;
  durationSeconds: number;
  motionPrompt?: string; // injected as `prompt` to Veo frames-to-video / ingredients-to-video
}

export interface ScriptResult {
  fullScript: string;
  scenes: ScriptScene[];
  wordCount: number;
}

export interface VoiceoverResult {
  audioPath: string;
  durationSeconds: number;
}

export interface ImageResult {
  sceneIndex: number;
  imagePath: string;
  prompt: string;
}

export interface AnimationResult {
  sceneIndex: number;
  clipPath: string;
  durationSeconds: number;
  clipIndex?: number;   // index dans la scène (multi-clips)
  isMock?: boolean;
}

export interface ArchiveItem {
  sceneIndex: number;
  type: "image" | "video";
  filePath: string;           // chemin local après download + attribution brûlée
  originalUrl: string;        // URL source originale
  source: "wikimedia" | "pexels";
  attribution: {
    author: string;
    license: string;          // e.g. "CC BY-SA 4.0", "Pexels License"
    pageUrl: string;          // lien vers la page source
  };
  durationSeconds?: number;   // vidéos uniquement
  query: string;              // requête de recherche utilisée
}

export interface ArchiveResult {
  items: ArchiveItem[];
  creditsPath: string;        // chemin vers credits.txt
}

export interface MusicResult {
  audioPath: string;
  durationSeconds: number;
  genre?: string;
}

export interface ThumbnailResult {
  imagePath: string;
  prompt: string;
}

export interface MontageResult {
  videoPath: string;
  durationSeconds: number;
  fileSize: number;
}

export interface PipelineStepEvent {
  step: PipelineStepName;
  status: PipelineJobStatus;
  progress: number; // 0-100
  message: string;
  data?: unknown;
}

export interface PipelineJob {
  id: string;
  params: PipelineJobParams;
  status: PipelineJobStatus;
  currentStep: PipelineStepName | null;
  steps: Partial<Record<PipelineStepName, { status: PipelineJobStatus; progress: number; message: string }>>;
  result: {
    script?: ScriptResult;
    voiceover?: VoiceoverResult;
    images?: ImageResult[];
    brollImages?: ImageResult[];
    archives?: ArchiveResult;
    animation?: AnimationResult[];
    music?: MusicResult;
    thumbnails?: ThumbnailResult;
    montage?: MontageResult;
  };
  createdAt: string;
  error?: string;
  pilotIndices?: number[]; // when pilotMode is true, the scene indices selected for the pilot run
  resumedFromPilotId?: string; // when this job reused outputs from a pilot, the source pilot job id
  /** Set true while the runner is blocked at the voiceover gate, false once a decision is received. */
  awaitingVoiceoverApproval?: boolean;
  /** Decision dropped by the /api/pipeline/voiceover-decision endpoint. The runner polls this and clears it on read. */
  voiceoverDecision?: "approve" | "regenerate" | "cancel";
  /** Optional per-regen overrides supplied with a "regenerate" decision. */
  voiceoverOverrides?: {
    voix?: string;
    voiceModel?: "genaipro" | "elevenlabs" | "fishspeech";
    genaiproTTSModel?: "eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_flash_v2_5" | "eleven_v3";
    voiceSpeed?: number;
  };
}
