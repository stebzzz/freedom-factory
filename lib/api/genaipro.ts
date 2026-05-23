import { writeFile, readFile } from "fs/promises";
import path from "path";
import { AnimationResult, ImageResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

const API_BASE = "https://genaipro.io/api";
const ASPECT = "VIDEO_ASPECT_RATIO_LANDSCAPE";
const ASPECT_IMG = "IMAGE_ASPECT_RATIO_LANDSCAPE";
const IMAGE_MODEL = process.env.GENAIPRO_IMAGE_MODEL || "nano_banana_pro";
const POLL_INTERVAL_MS = 12_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const STUCK_AFTER_MS = 12 * 60 * 1000;

const VEO3_DURATION_SEC = 8;

interface VeoHistory {
  id: string;
  status: "pending" | "processing" | "completed" | "failed" | string;
  file_urls?: string[];
  error?: string;
}

async function loadToken(): Promise<string> {
  const config = await getConfig();
  const k =
    process.env.GENAIPRO_API_KEY ||
    process.env.GENAIPRO_TOKEN ||
    (config as unknown as { genaiproKey?: string }).genaiproKey ||
    "";
  if (!k) throw new Error("GENAIPRO_API_KEY manquante (env ou config)");
  return k;
}

function rewriteCdnUrl(url: string): string {
  const m = url.match(/^https?:\/\/files\.genaipro\.(?:vn|io)\/(.+)$/);
  return m ? `https://genaipro.io/files/${m[1]}` : url;
}

async function downloadToFile(url: string, outputPath: string): Promise<number> {
  const target = rewriteCdnUrl(url);
  const res = await fetch(target, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${res.status} ${target}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buf);
  return buf.length;
}

async function postCreateImageOnce(
  token: string,
  prompt: string,
  aspectRatio: string,
  referenceImagePaths: string[],
): Promise<VeoHistory> {
  if (referenceImagePaths.length > 5) {
    throw new Error(`create-image: max 5 reference images (got ${referenceImagePaths.length}) — Veo API limit`);
  }
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("aspect_ratio", aspectRatio);
  fd.append("number_of_images", "1");
  fd.append("model", IMAGE_MODEL);

  for (const imagePath of referenceImagePaths) {
    const buffer = await readFile(imagePath);
    const filename = path.basename(imagePath);
    const ext = filename.split(".").pop()?.toLowerCase() || "png";
    const mime =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "webp" ? "image/webp" : "image/png";
    fd.append("reference_images", new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  }

  const res = await fetch(`${API_BASE}/v2/veo/create-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`create-image ${res.status}: ${text.slice(0, 400)}`);
  }
  // create-image returns a single object { id, status, file_urls, ... } — NOT { histories: [...] }
  const data = (await res.json()) as VeoHistory;
  if (!data.id) throw new Error(`create-image: no id in response (${JSON.stringify(data).slice(0, 200)})`);
  return data;
}

function isRetriable(err: unknown): boolean {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`.toLowerCase();
  const code = e?.cause?.code ?? "";
  // Transport-level / transient failures we want to retry. A 4xx with a body is
  // surfaced via `${res.status}:` and stays out of this set on purpose.
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EPIPE" || code === "UND_ERR_SOCKET" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return true;
  }
  if (msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("network") || msg.includes("aborted")) {
    return true;
  }
  // 429 or 5xx in the response body.
  const m = msg.match(/create-image (\d{3})/);
  if (m) {
    const status = parseInt(m[1], 10);
    return status === 429 || status >= 500;
  }
  return false;
}

async function postCreateImage(
  token: string,
  prompt: string,
  aspectRatio: string = ASPECT_IMG,
  referenceImagePaths: string[] = [],
): Promise<VeoHistory> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await postCreateImageOnce(token, prompt, aspectRatio, referenceImagePaths);
    } catch (err) {
      lastErr = err;
      const retriable = isRetriable(err) && attempt < maxAttempts;
      const e = err as { message?: string; cause?: { code?: string; message?: string } };
      const where = e?.cause?.code ?? e?.cause?.message ?? "";
      console.warn(
        `[Veo3-IMG] post attempt ${attempt}/${maxAttempts} failed: ${e?.message ?? err}${where ? ` (cause: ${where})` : ""}${retriable ? ` — retry in ${attempt * 4}s` : retriable === false && attempt < maxAttempts ? " (non-retriable, giving up)" : ""}`,
      );
      if (!retriable) break;
      await new Promise((r) => setTimeout(r, attempt * 4_000));
    }
  }
  throw lastErr ?? new Error("postCreateImage: unknown failure");
}

async function postTextToVideo(token: string, prompt: string): Promise<VeoHistory> {
  const res = await fetch(`${API_BASE}/v2/veo/text-to-video`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, aspect_ratio: ASPECT, number_of_videos: 1 }),
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`text-to-video ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { histories?: VeoHistory[] };
  const history = data.histories?.[0];
  if (!history) throw new Error("text-to-video: no history");
  return history;
}

async function postIngredientsToVideo(token: string, imagePaths: string[], prompt: string): Promise<VeoHistory> {
  if (imagePaths.length === 0) throw new Error("ingredients-to-video: at least one reference image required");
  if (imagePaths.length > 3) throw new Error(`ingredients-to-video: max 3 reference images (got ${imagePaths.length}) — Veo API limit`);
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("aspect_ratio", ASPECT);
  fd.append("number_of_videos", "1");

  for (const imagePath of imagePaths) {
    const buffer = await readFile(imagePath);
    const filename = path.basename(imagePath);
    const ext = filename.split(".").pop()?.toLowerCase() || "png";
    const mime =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "webp" ? "image/webp" : "image/png";
    fd.append("reference_images", new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  }

  const res = await fetch(`${API_BASE}/v2/veo/ingredients-to-video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`ingredients-to-video ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { histories?: VeoHistory[] };
  const history = data.histories?.[0];
  if (!history) throw new Error("ingredients-to-video: no history");
  return history;
}

async function postFramesToVideo(token: string, imagePath: string, prompt: string): Promise<VeoHistory> {
  const buffer = await readFile(imagePath);
  const filename = path.basename(imagePath);
  const ext = filename.split(".").pop()?.toLowerCase() || "png";
  const mime =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
    ext === "webp" ? "image/webp" : "image/png";

  const fd = new FormData();
  fd.append("start_image", new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  fd.append("prompt", prompt);
  fd.append("aspect_ratio", ASPECT);
  fd.append("number_of_videos", "1");

  const res = await fetch(`${API_BASE}/v2/veo/frames-to-video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`frames-to-video ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { histories?: VeoHistory[] };
  const history = data.histories?.[0];
  if (!history) throw new Error("frames-to-video: no history");
  return history;
}

async function pollUntilDone(
  token: string,
  taskIds: Set<string>,
  label: string,
  onComplete?: (taskId: string, history: VeoHistory) => Promise<void> | void,
): Promise<Map<string, VeoHistory>> {
  const pending = new Set(taskIds);
  const results = new Map<string, VeoHistory>();
  const start = Date.now();
  while (pending.size > 0) {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      console.warn(`[${label}] poll timeout after ${POLL_TIMEOUT_MS / 1000}s, pending=${pending.size}`);
      break;
    }
    let page = 1;
    while (pending.size > 0) {
      const res = await fetch(
        `${API_BASE}/v2/veo/histories?page=${page}&page_size=100`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (!res.ok) throw new Error(`histories ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data?: VeoHistory[]; total_pages?: number };
      const items = body.data ?? [];
      const justCompleted: Array<{ id: string; history: VeoHistory }> = [];
      for (const item of items) {
        if (!pending.has(item.id)) continue;
        if (item.status === "completed" || item.status === "failed") {
          results.set(item.id, item);
          pending.delete(item.id);
          justCompleted.push({ id: item.id, history: item });
        }
      }
      // Fire the per-task callback for everything that flipped on this page. Errors here
      // (e.g. download failures) must not bring down the poll loop.
      if (onComplete && justCompleted.length > 0) {
        await Promise.all(
          justCompleted.map(async ({ id, history }) => {
            try {
              await onComplete(id, history);
            } catch (err) {
              console.warn(`[${label}] onComplete handler threw for ${id}:`, (err as Error).message);
            }
          }),
        );
      }
      const totalPages = body.total_pages ?? 1;
      if (page >= totalPages || items.length === 0) break;
      page++;
    }
    if (pending.size === 0) break;
    if (Date.now() - start > STUCK_AFTER_MS) {
      const stuckEntries: Array<{ id: string; history: VeoHistory }> = [];
      for (const id of pending) {
        const h: VeoHistory = { id, status: "failed", error: "stuck >12min" };
        results.set(id, h);
        stuckEntries.push({ id, history: h });
      }
      // Surface stuck tasks via the callback too — caller may want to mark them failed in the UI.
      if (onComplete) {
        await Promise.all(stuckEntries.map(async ({ id, history }) => {
          try { await onComplete(id, history); } catch { /* swallow */ }
        }));
      }
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return results;
}

export async function generateImage(
  prompt: string,
  sceneIndex: number,
  outputPath: string,
  referenceImagePaths: string[] = [],
): Promise<ImageResult> {
  let token: string;
  try {
    token = await loadToken();
  } catch {
    console.log(`[Veo3-IMG] mock - scene ${sceneIndex} (no API key)`);
    await writeFile(outputPath, Buffer.from("mock-image"));
    return { sceneIndex, imagePath: outputPath, prompt };
  }

  console.log(`[Veo3-IMG] Scene ${sceneIndex}${referenceImagePaths.length ? ` (with ${referenceImagePaths.length} ref)` : ""}`);
  const history = await postCreateImage(token, prompt, ASPECT_IMG, referenceImagePaths);
  const results = await pollUntilDone(token, new Set([history.id]), `Veo3-IMG #${sceneIndex}`);
  const result = results.get(history.id);
  if (!result || result.status !== "completed" || !result.file_urls?.[0]) {
    throw new Error(`IMG failed scene ${sceneIndex}: ${result?.error ?? result?.status ?? "no result"}`);
  }
  const size = await downloadToFile(result.file_urls[0], outputPath);
  console.log(`[Veo3-IMG] OK scene ${sceneIndex} → ${outputPath} (${(size / 1024).toFixed(0)} kB)`);
  return { sceneIndex, imagePath: outputPath, prompt };
}

// All image quality tiers route to the same GenAIPro endpoint (single model).
export const generateImagePremium = generateImage;
export const generateImageBulk = generateImage;

export async function generateThumbnail(
  prompt: string,
  outputPath: string,
  referenceImagePaths: string[] = [],
): Promise<ImageResult> {
  return generateImage(prompt, 0, outputPath, referenceImagePaths);
}

export async function generateImages(
  scenes: Array<{ index: number; imagePrompt: string }>,
  outputDir: string,
  onProgress: (done: number, total: number) => void,
  options: {
    premiumScenes?: number[];
    useBulk?: boolean;
    concurrency?: number;
    referenceImagePaths?: string[];
    /** Per-scene resolver — when set, takes precedence over referenceImagePaths. Lets a style kit route different refs per scene (e.g. character vs style buckets). */
    resolveRefsForScene?: (sceneIndex: number, imagePrompt: string) => Promise<string[]>;
    /** Fires as soon as a scene's image is downloaded — lets the runner stream thumbnails to the UI before the whole batch finishes. */
    onImageReady?: (result: ImageResult) => void;
    /** Fires when a scene's post or download fails (after retries). */
    onImageFailed?: (sceneIndex: number, error: string) => void;
  } = {},
): Promise<ImageResult[]> {
  const refPaths = options.referenceImagePaths ?? [];
  const resolver = options.resolveRefsForScene;
  if (!resolver && refPaths.length > 5) {
    throw new Error(`generateImages: max 5 reference images (got ${refPaths.length}) — Veo create-image API limit`);
  }
  let token: string;
  try {
    token = await loadToken();
  } catch {
    console.warn("[Veo3-IMG] no API key — returning mock images");
    return scenes.map((s) => {
      const imagePath = `${outputDir}/scene_${String(s.index).padStart(3, "0")}.png`;
      return { sceneIndex: s.index, imagePath, prompt: s.imagePrompt };
    });
  }

  // Throttle conservateur — Google Veo upstream throttle facilement quand on burst.
  // Concurrency 3 + 15s entre batches = ~12 req/min, identique au throttle Geminigen.
  // (Avant : 3-8 simultanés sans pause → ~180 req/min en pointe, ce qui pétait Veo régulièrement.)
  const hasRefs = !!resolver || refPaths.length > 0;
  const concurrency = options.concurrency ?? 3;
  const BATCH_SLEEP_MS = 15_000;
  console.log(`[Veo3-IMG] ${scenes.length} images to generate (concurrency=${concurrency}, refs=${hasRefs ? "yes" : "no"}, sleep=${BATCH_SLEEP_MS}ms between batches)`);

  // 1. POST all jobs in batches.
  const taskByScene = new Map<string, { scene: typeof scenes[number]; imagePath: string }>();
  for (let i = 0; i < scenes.length; i += concurrency) {
    const batch = scenes.slice(i, i + concurrency);
    const histories = await Promise.allSettled(
      batch.map(async (scene) => {
        const sceneRefs = resolver ? (await resolver(scene.index, scene.imagePrompt)).slice(0, 5) : refPaths;
        const history = await postCreateImage(token, scene.imagePrompt, ASPECT_IMG, sceneRefs);
        return { scene, taskId: history.id };
      })
    );
    for (let j = 0; j < histories.length; j++) {
      const r = histories[j];
      const scene = batch[j];
      if (r.status === "fulfilled") {
        const { taskId } = r.value;
        const imagePath = `${outputDir}/scene_${String(scene.index).padStart(3, "0")}.png`;
        taskByScene.set(taskId, { scene, imagePath });
      } else {
        const reason = r.reason as { message?: string; cause?: { code?: string; message?: string } } | undefined;
        const where = reason?.cause?.code ?? reason?.cause?.message ?? "";
        console.warn(
          `[Veo3-IMG] scene ${scene.index} post failed after retries: ${reason?.message ?? r.reason}${where ? ` (cause: ${where})` : ""}`,
        );
      }
    }
    onProgress(Math.min(i + batch.length, scenes.length), scenes.length * 2);

    // Pause entre batches pour laisser Veo respirer côté Google.
    if (i + concurrency < scenes.length) {
      await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
    }
  }

  // 2+3. Poll AND download in interleaved fashion — each task that flips to "completed"
  // is downloaded immediately so the UI can render thumbnails progressively instead of
  // waiting for the slowest scene to finish before anything appears.
  const taskIds = new Set(taskByScene.keys());
  const out: ImageResult[] = [];
  let done = 0;

  // Surface scenes whose POST never succeeded as failures right away so the UI shows them
  // as red without waiting for the poll loop to no-op past them.
  const submittedSceneIndexes = new Set([...taskByScene.values()].map((v) => v.scene.index));
  for (const scene of scenes) {
    if (!submittedSceneIndexes.has(scene.index)) {
      options.onImageFailed?.(scene.index, "post failed (no task id)");
    }
  }

  await pollUntilDone(token, taskIds, "Veo3-IMG batch", async (taskId, history) => {
    const entry = taskByScene.get(taskId);
    if (!entry) return;
    const { scene, imagePath } = entry;
    if (history.status !== "completed" || !history.file_urls?.[0]) {
      const errMsg = history.error ?? history.status ?? "no result";
      console.warn(`[Veo3-IMG] scene ${scene.index} failed: ${errMsg}`);
      out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
      options.onImageFailed?.(scene.index, String(errMsg));
    } else {
      try {
        await downloadToFile(history.file_urls[0], imagePath);
        const result: ImageResult = { sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt };
        out.push(result);
        options.onImageReady?.(result);
      } catch (e) {
        const errMsg = (e as Error).message;
        console.warn(`[Veo3-IMG] scene ${scene.index} download failed: ${errMsg}`);
        out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
        options.onImageFailed?.(scene.index, errMsg);
      }
    }
    done++;
    onProgress(scenes.length + done, scenes.length * 2);
  });

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}

export async function generateT2VClip(
  prompt: string,
  sceneIndex: number,
  outputPath: string,
  clipIndex: number = 0,
): Promise<AnimationResult> {
  let token: string;
  try {
    token = await loadToken();
  } catch {
    console.log(`[Veo3-T2V] mock - scene ${sceneIndex}[${clipIndex}] (no API key)`);
    await writeFile(outputPath, Buffer.from("mock-clip"));
    return { sceneIndex, clipPath: outputPath, durationSeconds: VEO3_DURATION_SEC, clipIndex, isMock: true };
  }

  console.log(`[Veo3-T2V] Scene ${sceneIndex}[${clipIndex}]`);
  const history = await postTextToVideo(token, prompt);
  const results = await pollUntilDone(token, new Set([history.id]), `Veo3-T2V #${sceneIndex}`);
  const result = results.get(history.id);
  if (!result || result.status !== "completed" || !result.file_urls?.[0]) {
    throw new Error(`T2V failed scene ${sceneIndex}: ${result?.error ?? result?.status ?? "no result"}`);
  }
  const size = await downloadToFile(result.file_urls[0], outputPath);
  console.log(`[Veo3-T2V] OK scene ${sceneIndex}[${clipIndex}] → ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
  return { sceneIndex, clipPath: outputPath, durationSeconds: VEO3_DURATION_SEC, clipIndex };
}

export async function animateImage(
  imagePath: string,
  motionPrompt: string,
  sceneIndex: number,
  outputPath: string,
  durationSeconds: number = VEO3_DURATION_SEC,
  clipIndex: number = 0,
): Promise<AnimationResult> {
  let token: string;
  try {
    token = await loadToken();
  } catch {
    console.log(`[Veo3-I2V] mock - scene ${sceneIndex} (no API key)`);
    await writeFile(outputPath, Buffer.from("mock-clip"));
    return { sceneIndex, clipPath: imagePath, durationSeconds, isMock: true };
  }

  console.log(`[Veo3-I2V] Scene ${sceneIndex}`);
  const history = await postFramesToVideo(token, imagePath, motionPrompt);
  const results = await pollUntilDone(token, new Set([history.id]), `Veo3-I2V #${sceneIndex}`);
  const result = results.get(history.id);
  if (!result || result.status !== "completed" || !result.file_urls?.[0]) {
    throw new Error(`I2V failed scene ${sceneIndex}: ${result?.error ?? result?.status ?? "no result"}`);
  }
  const size = await downloadToFile(result.file_urls[0], outputPath);
  console.log(`[Veo3-I2V] OK scene ${sceneIndex}[${clipIndex}] → ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
  return { sceneIndex, clipPath: outputPath, durationSeconds, clipIndex };
}

export async function generateIngredientsClip(
  prompt: string,
  imagePaths: string[],
  sceneIndex: number,
  outputPath: string,
  durationSeconds: number = VEO3_DURATION_SEC,
  clipIndex: number = 0,
): Promise<AnimationResult> {
  let token: string;
  try {
    token = await loadToken();
  } catch {
    console.log(`[Veo3-Ingr] mock - scene ${sceneIndex}`);
    await writeFile(outputPath, Buffer.from("mock-clip"));
    return { sceneIndex, clipPath: imagePaths[0] ?? outputPath, durationSeconds, isMock: true };
  }

  console.log(`[Veo3-Ingr] Scene ${sceneIndex} (${imagePaths.length} refs)`);
  const history = await postIngredientsToVideo(token, imagePaths, prompt);
  const results = await pollUntilDone(token, new Set([history.id]), `Veo3-Ingr #${sceneIndex}`);
  const result = results.get(history.id);
  if (!result || result.status !== "completed" || !result.file_urls?.[0]) {
    throw new Error(`Ingr failed scene ${sceneIndex}: ${result?.error ?? result?.status ?? "no result"}`);
  }
  const size = await downloadToFile(result.file_urls[0], outputPath);
  console.log(`[Veo3-Ingr] OK scene ${sceneIndex}[${clipIndex}] → ${outputPath} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
  return { sceneIndex, clipPath: outputPath, durationSeconds, clipIndex };
}

/**
 * Animate N images concurrently via GenAIPro Veo3 frames-to-video.
 * Posts all jobs first (rate-limited), then polls all in batch — efficient API usage.
 */
export async function animateImages(
  images: Array<{ imagePath: string; sceneIndex: number; motionPrompt?: string }>,
  outputDir: string,
  scenes: Array<{ durationSeconds: number }>,
  onProgress: (done: number, total: number) => void,
  concurrency = 8,
): Promise<AnimationResult[]> {
  let token: string;
  try {
    token = await loadToken();
  } catch {
    console.warn("[Veo3] no API key — returning mock clips for all images");
    return images.map((img) => ({
      sceneIndex: img.sceneIndex,
      clipPath: img.imagePath,
      durationSeconds: scenes[img.sceneIndex]?.durationSeconds || VEO3_DURATION_SEC,
      isMock: true,
    }));
  }

  console.log(`[Veo3-I2V] ${images.length} images to animate (concurrency=${concurrency})`);

  // 1. POST all jobs in batches.
  const taskByImage = new Map<string, { img: typeof images[number]; clipPath: string; duration: number }>();
  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);
    const histories = await Promise.allSettled(
      batch.map(async (img) => {
        const motionPrompt = img.motionPrompt || "Slow cinematic camera movement, smooth pan";
        const history = await postFramesToVideo(token, img.imagePath, motionPrompt);
        return { img, taskId: history.id };
      })
    );
    for (const r of histories) {
      if (r.status === "fulfilled") {
        const { img, taskId } = r.value;
        const clipPath = `${outputDir}/clip_${String(img.sceneIndex).padStart(3, "0")}.mp4`;
        const duration = scenes[img.sceneIndex]?.durationSeconds || VEO3_DURATION_SEC;
        taskByImage.set(taskId, { img, clipPath, duration });
      }
    }
    onProgress(Math.min(i + batch.length, images.length), images.length * 2); // 0-50% = posting
  }

  // 2. Poll all at once.
  const taskIds = new Set(taskByImage.keys());
  const results = await pollUntilDone(token, taskIds, "Veo3-I2V batch");

  // 3. Download completed clips concurrently.
  const out: AnimationResult[] = [];
  let done = 0;
  const downloadConcurrency = 5;
  const tasks = [...taskByImage.entries()];
  for (let i = 0; i < tasks.length; i += downloadConcurrency) {
    const batch = tasks.slice(i, i + downloadConcurrency);
    await Promise.all(
      batch.map(async ([taskId, { img, clipPath, duration }]) => {
        const result = results.get(taskId);
        if (!result || result.status !== "completed" || !result.file_urls?.[0]) {
          console.warn(`[Veo3-I2V] scene ${img.sceneIndex} failed: ${result?.error ?? result?.status ?? "no result"}`);
          out.push({ sceneIndex: img.sceneIndex, clipPath: img.imagePath, durationSeconds: duration, isMock: true });
        } else {
          try {
            await downloadToFile(result.file_urls[0], clipPath);
            out.push({ sceneIndex: img.sceneIndex, clipPath, durationSeconds: duration });
          } catch (e) {
            console.warn(`[Veo3-I2V] scene ${img.sceneIndex} download failed: ${(e as Error).message}`);
            out.push({ sceneIndex: img.sceneIndex, clipPath: img.imagePath, durationSeconds: duration, isMock: true });
          }
        }
        done++;
        onProgress(images.length + done, images.length * 2); // 50-100%
      })
    );
  }

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}
