import { callClaudeWithImage } from "./claude-wrapper-client";

interface ClassifyResult {
  hasCharacter: boolean;
  label: string;
}

const SYSTEM_PROMPT = `You classify reference images for an illustration style kit.
The user is building an explainer-video moodboard. They want to know if each image
contains a STICK-FIGURE or HUMAN CHARACTER that should anchor scenes featuring people.

Reply with ONE LINE of strict JSON, nothing else:
{"has_character": true|false, "label": "<3-6 word description>"}

Rules:
- has_character is TRUE if the image clearly shows a person, stick figure, body, or face — even small or stylized.
- has_character is FALSE for pure objects, landscapes, color palettes, typography, textures, icons.
- label is a short tag like "stickman beside fire", "campfire glow", "city skyline", "color palette pastels".`;

export async function classifyImage(imagePath: string): Promise<ClassifyResult> {
  const raw = await callClaudeWithImage(
    "Classify this image.",
    imagePath,
    SYSTEM_PROMPT,
    "Claude Vision Classify",
  );

  // Tolerate ```json fences if the model decides to wrap.
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(stripped) as { has_character?: boolean; label?: string };
    return {
      hasCharacter: parsed.has_character === true,
      label: typeof parsed.label === "string" ? parsed.label : "",
    };
  } catch {
    // Best-effort fallback: look for the literal "true"/"false" near has_character.
    const m = stripped.match(/has_character\s*[:=]\s*(true|false)/i);
    return {
      hasCharacter: m ? m[1].toLowerCase() === "true" : false,
      label: stripped.slice(0, 80),
    };
  }
}

const STYLE_SYSTEM = `You are a visual style analyst. Look at this single frame from a YouTube video and describe its illustration style with ULTRA-SPECIFIC detail so another AI can replicate it.

Cover, in this order, in ONE paragraph (40-80 words, no bullets):
1. Medium and technique (e.g. "flat 2D cartoon", "watercolor", "3D Pixar-like", "stop-motion clay")
2. Line work (thickness, color, wobble, presence/absence of outlines)
3. Character anatomy if any (head shape, body proportions, hand style, face features)
4. Color palette (3-4 dominant colors, saturation, harmony — name actual colors)
5. Composition (centered, rule of thirds, framing, negative space)
6. Mood/lighting (flat vs lit, warm vs cool, contrast level, texture/grain)

Reply with the paragraph only — no preamble, no JSON, no labels.`;

/**
 * Send one frame to Claude vision and ask for a ~60-word style description.
 * Used by the style-kit YouTube import to build a consolidated brief.
 */
export async function describeStyle(imagePath: string): Promise<string> {
  return (await callClaudeWithImage(
    "Describe the style.",
    imagePath,
    STYLE_SYSTEM,
    "Claude Vision Style",
  )).trim();
}

const DESCRIBE_IMAGE_SYSTEM = `You write detailed image-generation prompts. Look at this image and produce ONE paragraph (90-140 words) that another text-to-image model could use to recreate it as faithfully as possible.

Cover, woven naturally into the paragraph:
- Subject and pose (what/who is in the image, exact stance, gesture, expression)
- Setting and background (location, props, scale, depth, what's behind/around)
- Camera framing (shot type, angle, distance, perspective)
- Medium and rendering style (e.g. "flat 2D cartoon", "watercolor", "oil painting", "3D render", "photorealistic", "ink line art")
- Line work and outlines if any (thickness, color, presence/absence)
- Color palette (3-5 dominant colors named explicitly, saturation, harmony)
- Lighting and mood (direction, warmth, contrast, shadows, time of day)
- Texture and finish (grain, paper texture, smooth digital, brush strokes)

Reply with the paragraph only — no preamble, no labels, no JSON, no bullets, no quotes.`;

/**
 * Generate a standalone, detailed image-generation prompt that describes one image.
 * Different from describeStyle: this targets re-creating THIS exact image, not the overall style.
 */
export async function describeImage(imagePath: string): Promise<string> {
  return (await callClaudeWithImage(
    "Write the prompt.",
    imagePath,
    DESCRIBE_IMAGE_SYSTEM,
    "Claude Vision Describe",
  )).trim();
}

export interface ImageIssueResult {
  severity: "ok" | "minor" | "bad";
  issues: string[];
}

const QC_SYSTEM = `You are a strict quality-control reviewer for AI-generated illustration frames used in a YouTube video. Look at the single image and flag concrete defects that would make it unusable or jarring on screen.

Check for, in priority order:
- Anatomy errors: malformed/extra/missing fingers or hands, fused limbs, broken faces, melted features, wrong number of eyes.
- Gibberish text or fake letters/words rendered in the image (signs, books, labels) that read as nonsense.
- Bad artifacts: smearing, duplicated/cloned subjects, warped objects, glitch textures, heavy noise.
- Composition fails: subject cropped badly, empty/blank frame, watermark, border, collage of mismatched panels.
- Style breaks: photorealistic face on a cartoon body, a subject that clearly doesn't match the intended illustration style.

Do NOT flag normal stylistic choices (flat colors, simple shapes, intentional minimalism) as defects.

Reply with ONE LINE of strict JSON, nothing else:
{"severity":"ok|minor|bad","issues":["short issue","..."]}

- "bad"   = clearly broken, must be regenerated.
- "minor" = small imperfection, usable but not great.
- "ok"    = no defect worth flagging (issues = []).
Keep each issue under 8 words.`;

/**
 * QC one generated image. Returns a severity + list of concrete defects.
 * Tolerant parser: any non-parseable answer is treated as "ok" (we don't want
 * a flaky model response to spuriously flag a good frame).
 */
export async function findImageIssues(imagePath: string): Promise<ImageIssueResult> {
  const raw = await callClaudeWithImage(
    "Review this frame for defects.",
    imagePath,
    QC_SYSTEM,
    "Claude Vision QC",
    "haiku", // bulk QC → fast model; the wrapper maps this to `claude -p --model haiku`
  );
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(stripped) as { severity?: string; issues?: unknown };
    const severity = parsed.severity === "bad" ? "bad" : parsed.severity === "minor" ? "minor" : "ok";
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map((i) => String(i)).filter(Boolean).slice(0, 6)
      : [];
    return { severity, issues: severity === "ok" ? [] : issues };
  } catch {
    // Couldn't parse → assume ok rather than flag a good image on a bad reply.
    return { severity: "ok", issues: [] };
  }
}
