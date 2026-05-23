import { readFile } from "fs/promises";
import path from "path";
import { getConfig } from "@/lib/config";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

interface ClassifyResult {
  hasCharacter: boolean;
  label: string;
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase().replace(".", "");
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
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
  const config = await getConfig();
  const apiKey = config.anthropicKey;
  if (!apiKey) throw new Error("classifyImage: ANTHROPIC_API_KEY missing");

  const buffer = await readFile(imagePath);
  const base64 = buffer.toString("base64");
  const mediaType = mimeFromPath(imagePath);

  const body = {
    model: HAIKU_MODEL,
    max_tokens: 120,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Classify this image." },
        ],
      },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`classifyImage ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const raw = data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";

  // Tolerate ```json fences if Haiku decides to wrap.
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
 * Send one frame to Haiku Vision and ask for a ~60-word style description.
 * Used by the style-kit YouTube import to build a consolidated brief.
 */
export async function describeStyle(imagePath: string): Promise<string> {
  const config = await getConfig();
  const apiKey = config.anthropicKey;
  if (!apiKey) throw new Error("describeStyle: ANTHROPIC_API_KEY missing");

  const buffer = await readFile(imagePath);
  const base64 = buffer.toString("base64");
  const mediaType = mimeFromPath(imagePath);

  const body = {
    model: HAIKU_MODEL,
    max_tokens: 220,
    system: STYLE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Describe the style." },
        ],
      },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`describeStyle ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
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
  const config = await getConfig();
  const apiKey = config.anthropicKey;
  if (!apiKey) throw new Error("describeImage: ANTHROPIC_API_KEY missing");

  const buffer = await readFile(imagePath);
  const base64 = buffer.toString("base64");
  const mediaType = mimeFromPath(imagePath);

  const body = {
    model: HAIKU_MODEL,
    max_tokens: 400,
    system: DESCRIBE_IMAGE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Write the prompt." },
        ],
      },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`describeImage ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
}
