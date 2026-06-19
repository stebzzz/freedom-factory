import { readFile, writeFile } from "fs/promises";
import path from "path";
import { AnimationResult, ImageResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

// Alibaba DashScope — WAN 2.7 image generation (Tongyi Wanxiang).
// Docs: https://www.alibabacloud.com/help/en/model-studio/wan-image-generation-and-editing-api-reference
//
// We use the SYNCHRONOUS multimodal endpoint — returns the image URL directly in the response,
// no polling required. Refs are inlined as data-URI base64 in the messages content array.
//
// Endpoint (Singapore — international region):
//   POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
// Auth:
//   Authorization: Bearer <DASHSCOPE_API_KEY>
//
// Models supported:
//   - wan2.7-image-pro   : 4K, thinking mode, best quality
//   - wan2.7-image       : standard, faster/cheaper (DEFAULT)
//
// Refs: 0 to 9 images per call, JPEG/PNG/WEBP/BMP, max 20MB each, 240-8000 px per dim.
// Region override: set DASHSCOPE_REGION=cn (Beijing) in env to use the China endpoint.

const REGION = (process.env.DASHSCOPE_REGION || "intl").toLowerCase();
const API_BASE = REGION === "cn"
  ? "https://dashscope.aliyuncs.com/api/v1"
  : "https://dashscope-intl.aliyuncs.com/api/v1";
const ENDPOINT = `${API_BASE}/services/aigc/multimodal-generation/generation`;
const DEFAULT_MODEL: WanModel = "wan2.7-image";
// Custom resolution to get 16:9 — "1K" alone defaults to 1024x1024 (square).
const DEFAULT_SIZE = "1280*720";

export type WanModel = "wan2.7-image" | "wan2.7-image-pro";

interface WanResponseContent {
  image?: string;
  text?: string;
  type?: string;
}

interface WanResponseChoice {
  message?: { role?: string; content?: WanResponseContent[] };
  finish_reason?: string;
}

interface WanResponse {
  output?: { choices?: WanResponseChoice[]; finished?: boolean };
  usage?: { image_count?: number; size?: string };
  code?: string;
  message?: string;
  request_id?: string;
}

async function loadKey(): Promise<string> {
  const config = await getConfig();
  const k = process.env.DASHSCOPE_API_KEY || (config as unknown as { dashscopeKey?: string }).dashscopeKey || "";
  if (!k) throw new Error("DASHSCOPE_API_KEY manquante (env ou config)");
  return k;
}

function mimeFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

async function refToDataUri(refPath: string): Promise<string> {
  const buf = await readFile(refPath);
  const mime = mimeFor(refPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function downloadToFile(url: string, outputPath: string): Promise<number> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download ${r.status}: ${outputPath}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(outputPath, buf);
  return buf.length;
}

// When ≥2 refs are sent, the first ref is the canonical style anchor (e.g. frame-005, a pure
// stickman with no scenery) and the second+ are scene-context references. The model needs to
// know that IMAGE 1 is a STYLE template (line work, proportions) — not something to copy
// pose-for-pose — otherwise every stickman ends up frozen in the same stance.
function wrapPromptWithRefHierarchy(prompt: string, refCount: number): string {
  if (refCount < 2) return prompt;
  return `STYLE REFERENCE (IMAGE 1): a generic stickman in this exact style — same line weight, head shape, proportions, simple eye dots, flat ink-line aesthetic. Use ONLY as STYLE TEMPLATE: replicate line quality and proportions, but the POSE, EXPRESSION, ACTION must be NEW matching the scene description. Do NOT copy IMAGE 1's stance.

SCENE REFERENCE (IMAGE 2): composition/object/environment inspiration. Layout hint only — do NOT copy its character style.

Scene to draw (NEW pose & action, IMAGE 1 line style only): ${prompt}`;
}

async function generateOne(
  key: string,
  model: WanModel,
  prompt: string,
  refPaths: string[],
): Promise<string> {
  // Build the multimodal content array: text + up to 9 ref images as data URIs.
  const wrappedPrompt = wrapPromptWithRefHierarchy(prompt, refPaths.length);
  const content: Array<{ text?: string; image?: string }> = [{ text: wrappedPrompt }];
  for (const p of refPaths.slice(0, 9)) {
    content.push({ image: await refToDataUri(p) });
  }

  const body = {
    model,
    input: {
      messages: [{ role: "user", content }],
    },
    parameters: {
      size: DEFAULT_SIZE,
      n: 1,
      watermark: false,
    },
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as WanResponse;
  if (!res.ok || data.code) {
    const msg = `${data.code ?? res.status}: ${data.message ?? "no message"}`;
    throw new Error(`WAN ${msg}`);
  }
  const url = data.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!url) {
    throw new Error(`WAN: no image URL in response (${JSON.stringify(data).slice(0, 200)})`);
  }
  return url;
}

// Rewrite a prompt to bypass content moderation (DataInspectionFailed, IPInfringementSuspect, …).
// We delegate to the same Claude rewriter the rest of the pipeline uses for moderation-safe rewrites.
async function rewriteSafePromptForWan(originalPrompt: string, sceneIndex: number, reason: "content" | "ip"): Promise<string> {
  try {
    const { rewritePrompt } = await import("./prompt-rewrite");
    const instruction = reason === "ip"
      ? "This prompt was flagged by DashScope as 'IP infringement suspect'. Rewrite it to remove ANY trademarks, brand names, real product names, copyrighted characters, named people (living or historical), recognisable logos, IP-protected designs, or distinctive copyrighted visual styles (e.g. specific film/anime/game looks). Use generic descriptions only: 'a phone', 'a soda can', 'a stickman', 'a generic explorer character'. Keep the same visual idea, same simple stickman / flat illustration style. Output only the rewritten English prompt, no preamble."
      : "This prompt was flagged for inappropriate content by an image-gen safety filter. Rewrite it to be ultra-safe: remove anything that could read as violence, weapons, blood, body parts, suggestive content, or proper names of living people. Keep the same visual idea, simple stickman / object style. Output only the rewritten English prompt.";
    const safe = await rewritePrompt(originalPrompt, instruction);
    console.log(`[WAN] scene ${sceneIndex} rewrote prompt (${reason}): "${safe.slice(0, 120)}..."`);
    return safe;
  } catch (err) {
    console.warn(`[WAN] scene ${sceneIndex} safe-rewrite failed (${(err as Error).message}), keeping original`);
    return originalPrompt;
  }
}

async function generateOneRetry(
  key: string,
  model: WanModel,
  prompt: string,
  refPaths: string[],
  sceneIndex: number,
): Promise<string> {
  let lastErr: Error | null = null;
  let currentPrompt = prompt;
  let alreadyRewrote = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await generateOne(key, model, currentPrompt, refPaths);
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      const isContentMod = /DataInspectionFailed|inappropriate content|content filter|safety/i.test(msg);
      const isIPMod = /IPInfringement|infringement|copyright|trademark/i.test(msg);
      const isModeration = isContentMod || isIPMod;
      const transient =
        /Throttling|RateLimit|TooManyRequests|429|5\d\d|fetch failed|ECONN|ETIMEDOUT/i.test(msg);

      // Moderation fail: try once with a safe-rewritten prompt (Claude paraphrases it,
      // targeting IP vs content-policy depending on which filter tripped).
      if (isModeration && !alreadyRewrote) {
        console.warn(`[WAN] scene ${sceneIndex} flagged by ${isIPMod ? "IP" : "content"} moderation, attempting safe rewrite...`);
        currentPrompt = await rewriteSafePromptForWan(prompt, sceneIndex, isIPMod ? "ip" : "content");
        alreadyRewrote = true;
        continue; // immediate retry with the rewritten prompt
      }
      if (!transient || attempt === 4) throw lastErr;
      const delay = attempt * 5000;
      console.warn(`[WAN] scene ${sceneIndex} retry ${attempt}/4 in ${delay}ms: ${msg.slice(0, 140)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error("WAN: exhausted retries");
}

// ===================================================================
// Global WAN rate gate — shared across ALL pipeline jobs in this process.
// Quand plusieurs jobs tournent en parallèle (queue concurrente), leurs étapes
// d'images partagent ce plafond → le total en vol vers DashScope reste borné,
// peu importe le nombre de jobs. Pool CONTINU (zéro temps mort) : jusqu'à
// WAN_GLOBAL_MAX requêtes en vol, ré-alimenté dès qu'une finit.
// Remplace l'ancien "batch de 3 → attendre → dormir 15s" qui passait ~40% du
// temps à dormir (3 images / ~40s ≈ 4,5/min). En continu à 6 en vol ≈ 12/min
// (le rythme VOULU à l'origine), soit ~2,5-3× plus rapide. Réglable via env.
// ===================================================================
const WAN_GLOBAL_MAX = Number(process.env.FF_WAN_GLOBAL_INFLIGHT) || 6;
const wanGate = globalThis as unknown as { __ff_wan_inflight?: number; __ff_wan_waiters?: Array<() => void> };
wanGate.__ff_wan_inflight ??= 0;
wanGate.__ff_wan_waiters ??= [];
async function wanAcquire(): Promise<void> {
  while ((wanGate.__ff_wan_inflight ?? 0) >= WAN_GLOBAL_MAX) {
    await new Promise<void>((resolve) => wanGate.__ff_wan_waiters!.push(resolve));
  }
  wanGate.__ff_wan_inflight = (wanGate.__ff_wan_inflight ?? 0) + 1;
}
function wanRelease(): void {
  wanGate.__ff_wan_inflight = Math.max(0, (wanGate.__ff_wan_inflight ?? 1) - 1);
  const next = wanGate.__ff_wan_waiters!.shift();
  if (next) next();
}

/** Drop-in replacement for GenAIPro / Geminigen `generateImages`. Same signature. */
export async function generateImages(
  scenes: Array<{ index: number; imagePrompt: string }>,
  outputDir: string,
  onProgress: (done: number, total: number) => void,
  options: {
    premiumScenes?: number[];
    concurrency?: number;
    referenceImagePaths?: string[];
    resolveRefsForScene?: (sceneIndex: number, imagePrompt: string) => Promise<string[]>;
    onImageReady?: (result: ImageResult) => void;
    onImageFailed?: (sceneIndex: number, error: string) => void;
    model?: WanModel;
  } = {},
): Promise<ImageResult[]> {
  const refPaths = options.referenceImagePaths ?? [];
  const resolver = options.resolveRefsForScene;
  const model = options.model ?? DEFAULT_MODEL;

  let key: string;
  try {
    key = await loadKey();
  } catch {
    console.warn("[WAN] no API key — returning mock images");
    return scenes.map((s) => ({
      sceneIndex: s.index,
      imagePath: `${outputDir}/scene_${String(s.index).padStart(3, "0")}.png`,
      prompt: s.imagePrompt,
    }));
  }

  // Pool CONTINU borné par le plafond GLOBAL (wanAcquire/wanRelease) — plus de
  // "batch de 3 → dormir 15s" (qui gâchait ~40% du temps). On lance toutes les
  // scènes ; chacune attend poliment un créneau global avant de partir. Le 429/
  // throttling reste géré par generateOneRetry (backoff). options.concurrency est
  // ignoré : c'est le plafond global FF_WAN_GLOBAL_INFLIGHT qui gouverne (et borne
  // aussi le total quand plusieurs jobs tournent en parallèle).
  const hasRefs = !!resolver || refPaths.length > 0;
  console.log(`[WAN] ${scenes.length} images (model=${model}, refs=${hasRefs ? "yes" : "no"}, plafond global=${WAN_GLOBAL_MAX} en vol, continu)`);

  const out: ImageResult[] = [];
  let done = 0;

  const processScene = async (scene: { index: number; imagePrompt: string }): Promise<void> => {
    await wanAcquire();
    try {
      const sceneRefs = resolver ? (await resolver(scene.index, scene.imagePrompt)).slice(0, 9) : refPaths;
      const imagePath = `${outputDir}/scene_${String(scene.index).padStart(3, "0")}.png`;
      try {
        const url = await generateOneRetry(key, model, scene.imagePrompt, sceneRefs, scene.index);
        await downloadToFile(url, imagePath);
        const result: ImageResult = { sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt };
        out.push(result);
        options.onImageReady?.(result);
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`[WAN] scene ${scene.index} failed: ${msg}`);
        out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
        options.onImageFailed?.(scene.index, msg);
      }
      done += 1;
      onProgress(done, scenes.length);
    } finally {
      wanRelease();
    }
  };

  await Promise.all(scenes.map((scene) => processScene(scene)));

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}

// =============================================================================
// I2V (image-to-video) — DashScope wan-i2v (async)
//   POST  /services/aigc/video-generation/video-synthesis   (header X-DashScope-Async: enable)
//   GET   /tasks/{task_id}                                  (poll until SUCCEEDED/FAILED)
// Same DASHSCOPE_API_KEY as the image endpoint above.
// =============================================================================
const I2V_SUBMIT = `${API_BASE}/services/aigc/video-generation/video-synthesis`;
const TASK_URL = (id: string) => `${API_BASE}/tasks/${id}`;
const I2V_DEFAULT_MODEL: WanI2VModel = "wan2.2-i2v-flash";
const I2V_DEFAULT_DURATION = 5; // seconds — wan-i2v outputs 5 or 10s clips
const I2V_POLL_INTERVAL_MS = 5000;
const I2V_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per clip

export type WanI2VModel = "wan2.2-i2v-flash" | "wan2.2-i2v-plus" | "wanx2.1-i2v-turbo" | "wanx2.1-i2v-plus";

interface I2VSubmitResponse {
  output?: { task_id?: string; task_status?: string };
  code?: string;
  message?: string;
  request_id?: string;
}

interface I2VTaskResponse {
  output?: {
    task_id?: string;
    task_status?: string; // PENDING | RUNNING | SUCCEEDED | FAILED | CANCELED | UNKNOWN
    video_url?: string;
    message?: string;
    code?: string;
  };
  code?: string;
  message?: string;
}

async function imageToDataUri(imagePath: string): Promise<string> {
  return refToDataUri(imagePath);
}

async function submitI2V(
  key: string,
  model: WanI2VModel,
  prompt: string,
  imageDataUri: string,
  durationSec: number,
): Promise<string> {
  const body = {
    model,
    input: { prompt, img_url: imageDataUri },
    parameters: {
      duration: durationSec,
      resolution: "720P",
      prompt_extend: true,
    },
  };
  const res = await fetch(I2V_SUBMIT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as I2VSubmitResponse;
  if (!res.ok || data.code) {
    throw new Error(`WAN-I2V submit ${data.code ?? res.status}: ${data.message ?? "no message"}`);
  }
  const taskId = data.output?.task_id;
  if (!taskId) throw new Error(`WAN-I2V: no task_id (${JSON.stringify(data).slice(0, 200)})`);
  return taskId;
}

async function pollI2V(key: string, taskId: string, label: string): Promise<string> {
  const deadline = Date.now() + I2V_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, I2V_POLL_INTERVAL_MS));
    const res = await fetch(TASK_URL(taskId), {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = (await res.json()) as I2VTaskResponse;
    const status = data.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = data.output?.video_url;
      if (!url) throw new Error(`WAN-I2V ${label}: SUCCEEDED but no video_url`);
      return url;
    }
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(`WAN-I2V ${label} ${status}: ${data.output?.message ?? data.message ?? "unknown"}`);
    }
    // PENDING / RUNNING / UNKNOWN → keep polling
  }
  throw new Error(`WAN-I2V ${label} timeout after ${I2V_TIMEOUT_MS / 1000}s`);
}

async function animateOneRetry(
  key: string,
  model: WanI2VModel,
  imagePath: string,
  motionPrompt: string,
  sceneIndex: number,
  durationSec: number,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const dataUri = await imageToDataUri(imagePath);
      const taskId = await submitI2V(key, model, motionPrompt, dataUri, durationSec);
      return await pollI2V(key, taskId, `scene ${sceneIndex}`);
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      const transient = /Throttling|RateLimit|TooManyRequests|429|5\d\d|fetch failed|ECONN|ETIMEDOUT|timeout/i.test(msg);
      if (!transient || attempt === 3) throw lastErr;
      const delay = attempt * 8000;
      console.warn(`[WAN-I2V] scene ${sceneIndex} retry ${attempt}/3 in ${delay}ms: ${msg.slice(0, 140)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error("WAN-I2V: exhausted retries");
}

/** Drop-in replacement for GenAIPro `animateImages`. Same signature/contract. */
export async function animateImages(
  images: Array<{ imagePath: string; sceneIndex: number; motionPrompt?: string }>,
  outputDir: string,
  scenes: Array<{ durationSeconds: number }>,
  onProgress: (done: number, total: number) => void,
  options: { concurrency?: number; model?: WanI2VModel } = {},
): Promise<AnimationResult[]> {
  const model = options.model ?? I2V_DEFAULT_MODEL;
  // DashScope wan-i2v is async + heavy → low concurrency. 2 in-flight keeps the polling cost sane
  // while letting two clips overlap their generation time (each takes 60-180s).
  const concurrency = options.concurrency ?? 2;

  let key: string;
  try {
    key = await loadKey();
  } catch {
    console.warn("[WAN-I2V] no API key — returning mock clips");
    return images.map((img) => ({
      sceneIndex: img.sceneIndex,
      clipPath: img.imagePath,
      durationSeconds: scenes[img.sceneIndex]?.durationSeconds ?? I2V_DEFAULT_DURATION,
      isMock: true,
    }));
  }

  console.log(`[WAN-I2V] ${images.length} clips (model=${model}, concurrency=${concurrency})`);
  const out: AnimationResult[] = [];
  let done = 0;
  const total = images.length;

  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (img) => {
        const sceneDur = scenes[img.sceneIndex]?.durationSeconds ?? I2V_DEFAULT_DURATION;
        // wan-i2v supports 5s or 10s. Round to the closest supported value, clamp 5..10.
        const requested = sceneDur >= 8 ? 10 : 5;
        const clipPath = `${outputDir}/clip_${String(img.sceneIndex).padStart(3, "0")}.mp4`;
        const motion = img.motionPrompt?.trim() || "Slow cinematic camera movement, smooth pan";
        try {
          const url = await animateOneRetry(key, model, img.imagePath, motion, img.sceneIndex, requested);
          await downloadToFile(url, clipPath);
          out.push({ sceneIndex: img.sceneIndex, clipPath, durationSeconds: requested });
        } catch (err) {
          console.warn(`[WAN-I2V] scene ${img.sceneIndex} failed: ${(err as Error).message}`);
          out.push({ sceneIndex: img.sceneIndex, clipPath: img.imagePath, durationSeconds: sceneDur, isMock: true });
        }
        done += 1;
        onProgress(done, total);
      }),
    );
  }

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}
