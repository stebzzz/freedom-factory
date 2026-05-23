export type KitTag = "character" | "style";

/** "classify" = split into character/style buckets (default). "describe" = no sorting, each image gets a detailed image-gen prompt. */
export type KitMode = "classify" | "describe";

export interface KitImage {
  filename: string;
  url: string;
  tag: KitTag;
  label?: string;
  sizeBytes: number;
  /** Detailed image-gen prompt for THIS image. Populated when the kit was imported in "describe" mode. */
  imagePrompt?: string;
}

export interface KitMeta {
  slug: string;
  sourcePdf?: string;
  sourceUrl?: string; // YouTube URL when the kit was built from a video
  createdAt: string;
  /** Defaults to "classify" for legacy kits without the field. */
  mode?: KitMode;
  character: KitImage[];
  style: KitImage[];
  /** Consolidated style brief produced by Claude from per-frame Vision analyses. Used as customStyle fallback. */
  styleBrief?: string;
  /** Detected narration language of the source video, used by the describe-kit script gen.
   *  Cached the first time we fetch + detect; persisted back into meta.json. */
  narrationLanguage?: "en" | "fr";
}

export interface KitSummary {
  slug: string;
  createdAt: string;
  mode: KitMode;
  characterCount: number;
  styleCount: number;
  previewUrl?: string;
  hasStyleBrief: boolean;
  source: "pdf" | "youtube" | "unknown";
}
