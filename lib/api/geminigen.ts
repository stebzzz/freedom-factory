import { readFile, writeFile } from "fs/promises";
import path from "path";
import { ImageResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

// GeminiGen.AI — Image generation provider (alternative to GenAIPro Veo).
// API docs : https://docs.geminigen.ai/resources/0.image-generation
//
// Endpoint : POST  https://api.geminigen.ai/uapi/v1/generate_image  (multipart/form-data)
// Polling  : GET   https://api.geminigen.ai/uapi/v1/history/<uuid>
// Auth     : header `x-api-key: <key>`
//
// Models (per docs):
//   - nano-banana-pro     (Gemini 3 Pro Image Preview)    — rate limit 5/min, 100/h, 1000/day
//   - nano-banana-2       (Gemini 3.1 Flash Image Preview) — no rate limit (DEFAULT)
//   - imagen-4            (Imagen 4)                       — no rate limit
//
// Response status codes (history `.status`):
//   1 = processing
//   2 = completed  (image URL in generated_image[0].image_url / file_download_url / image_uri)
//   3 = failed     (check error_code / error_message — upstream GEMINI_RATE_LIMIT is common)

const API_BASE = "https://api.geminigen.ai/uapi/v1";
const DEFAULT_MODEL: GeminigenModel = "nano-banana-2";
const ASPECT_RATIO = "16:9";
const OUTPUT_FORMAT = "jpeg";
const RESOLUTION = "1K";

const POLL_INTERVAL_MS = 8_000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000;
const STUCK_AFTER_MS = 9 * 60 * 1000;

export type GeminigenModel = "nano-banana-pro" | "nano-banana-2" | "imagen-4";

interface GeneratedImageEntry {
  uuid?: string;
  image_uri?: string | null;
  image_url?: string | null;
  file_download_url?: string | null;
  base64_data?: string | null;
  status?: number;
  error_message?: string | null;
}

interface HistoryResponse {
  id?: number;
  uuid?: string;
  status?: number;
  status_desc?: string;
  status_percentage?: number;
  error_code?: string;
  error_message?: string;
  generated_image?: GeneratedImageEntry[];
}

async function loadKey(): Promise<string> {
  const config = await getConfig();
  const k = process.env.GEMINIGEN_API_KEY || (config as unknown as { geminigenKey?: string }).geminigenKey || "";
  if (!k) throw new Error("GEMINIGEN_API_KEY manquante (env ou config)");
  return k;
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function downloadToFile(url: string, outputPath: string): Promise<number> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${res.status}: ${outputPath}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buf);
  return buf.length;
}

/** Submit a generation job. Returns the history `uuid` used for polling. */
async function postGenerateImage(
  key: string,
  prompt: string,
  refPaths: string[],
  model: GeminigenModel,
): Promise<{ uuid: string; id: number }> {
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("model", model);
  fd.append("aspect_ratio", ASPECT_RATIO);
  fd.append("output_format", OUTPUT_FORMAT);
  fd.append("resolution", RESOLUTION);

  // Attach refs as binary uploads — the docs use `files` (plural) for local images.
  for (const p of refPaths.slice(0, 5)) {
    const buf = await readFile(p);
    const blob = new Blob([buf as unknown as ArrayBuffer], { type: mimeFromPath(p) });
    fd.append("files", blob, path.basename(p));
  }

  const res = await fetch(`${API_BASE}/generate_image`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generate_image ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { id?: number; uuid?: string; error_message?: string };
  if (!data.uuid) throw new Error(`generate_image: no uuid in response (${JSON.stringify(data).slice(0, 200)})`);
  return { uuid: data.uuid, id: data.id ?? 0 };
}

/** Submit with retry for transient upstream errors (Gemini-side 429 / 5xx). */
async function postGenerateImageRetry(
  key: string,
  prompt: string,
  refPaths: string[],
  model: GeminigenModel,
  sceneIndex: number,
): Promise<{ uuid: string; id: number }> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await postGenerateImage(key, prompt, refPaths, model);
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      const m = msg.match(/generate_image (\d{3})/);
      const status = m ? parseInt(m[1], 10) : 0;
      const transient = status === 429 || status >= 500 || /fetch failed|ECONN|ETIMEDOUT/i.test(msg);
      if (!transient || attempt === 3) throw lastErr;
      const delay = attempt * 4000;
      console.warn(`[Geminigen] scene ${sceneIndex} post retry ${attempt}/3 in ${delay}ms: ${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error("postGenerateImageRetry: exhausted");
}

function pickImageUrl(entry: GeneratedImageEntry | undefined): string | null {
  if (!entry) return null;
  return entry.file_download_url || entry.image_url || entry.image_uri || null;
}

/** Poll one history until completed / failed / stuck. Returns the final state. */
async function pollHistory(
  key: string,
  uuid: string,
  label: string,
): Promise<HistoryResponse> {
  const start = Date.now();
  let lastPct = -1;
  while (true) {
    const r = await fetch(`${API_BASE}/history/${uuid}`, { headers: { "x-api-key": key } });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 15_000));
      continue;
    }
    if (!r.ok) throw new Error(`history ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as HistoryResponse;
    const status = body.status ?? 0;
    if (status === 2 || status === 3) return body;
    if ((body.status_percentage ?? 0) !== lastPct) {
      lastPct = body.status_percentage ?? 0;
    }
    if (Date.now() - start > STUCK_AFTER_MS) {
      console.warn(`[${label}] stuck > ${Math.round(STUCK_AFTER_MS / 1000)}s — bailing`);
      return { ...body, status: 3, error_message: `stuck >${Math.round(STUCK_AFTER_MS / 1000)}s` };
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      return { ...body, status: 3, error_message: "poll timeout" };
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

/** Drop-in replacement for GenAIPro's `generateImages` — same signature. */
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
    model?: GeminigenModel;
  } = {},
): Promise<ImageResult[]> {
  const refPaths = options.referenceImagePaths ?? [];
  const resolver = options.resolveRefsForScene;
  const model = options.model ?? DEFAULT_MODEL;

  let key: string;
  try {
    key = await loadKey();
  } catch {
    console.warn("[Geminigen] no API key — returning mock images");
    return scenes.map((s) => ({
      sceneIndex: s.index,
      imagePath: `${outputDir}/scene_${String(s.index).padStart(3, "0")}.jpg`,
      prompt: s.imagePrompt,
    }));
  }

  // Concurrency strategy (CONSERVATEUR — Google côté Gemini renvoie facilement
  // GEMINI_RATE_LIMIT en cas de burst, même si geminigen côté provider ne limite pas).
  //  - nano-banana-pro: provider rate-limit 5/min → 2 in-flight + 12s entre batches.
  //  - nano-banana-2 / imagen-4: 3 in-flight + 15s entre batches = 12 req/min. Retry auto sur GEMINI_RATE_LIMIT.
  const hasRefs = !!resolver || refPaths.length > 0;
  const defaultConc = model === "nano-banana-pro" ? 2 : 3;
  const concurrency = options.concurrency ?? defaultConc;
  console.log(`[Geminigen] ${scenes.length} images (model=${model}, concurrency=${concurrency}, refs=${hasRefs ? "yes" : "no"})`);

  // 1) Submit all jobs in batches. Each scene → uuid.
  const taskByScene = new Map<string, { scene: typeof scenes[number]; imagePath: string }>();
  const submittedSceneIdx = new Set<number>();
  for (let i = 0; i < scenes.length; i += concurrency) {
    const batch = scenes.slice(i, i + concurrency);
    const submits = await Promise.allSettled(
      batch.map(async (scene) => {
        const sceneRefs = resolver ? (await resolver(scene.index, scene.imagePrompt)).slice(0, 5) : refPaths;
        const { uuid } = await postGenerateImageRetry(key, scene.imagePrompt, sceneRefs, model, scene.index);
        return { scene, uuid };
      }),
    );
    for (let j = 0; j < submits.length; j++) {
      const r = submits[j];
      const scene = batch[j];
      if (r.status === "fulfilled") {
        const ext = OUTPUT_FORMAT === "jpeg" ? "jpg" : OUTPUT_FORMAT;
        const imagePath = `${outputDir}/scene_${String(scene.index).padStart(3, "0")}.${ext}`;
        taskByScene.set(r.value.uuid, { scene, imagePath });
        submittedSceneIdx.add(scene.index);
      } else {
        console.warn(`[Geminigen] scene ${scene.index} POST failed:`, (r.reason as Error).message);
        options.onImageFailed?.(scene.index, (r.reason as Error).message);
      }
    }
    onProgress(Math.min(i + batch.length, scenes.length), scenes.length * 2);

    // nano-banana-pro: 5/min → space submissions ~12s. Other models: brief pause to soften upstream bursts.
    if (i + concurrency < scenes.length) {
      // nano-banana-pro : 5/min → 12s entre batches de 2.
      // nano-banana-2 / imagen-4 : 15s entre batches de 3 = 12 req/min en pointe,
      // bien sous le seuil Google où GEMINI_RATE_LIMIT se déclenche.
      const sleep = model === "nano-banana-pro" ? 12_000 : 15_000;
      await new Promise((r) => setTimeout(r, sleep));
    }
  }

  // 2) Poll each task with bounded parallelism, download + emit on completion.
  //    On upstream GEMINI_RATE_LIMIT failure → resubmit ONCE after a 30s wait.
  const out: ImageResult[] = [];
  let done = 0;
  const POLL_CONC = 6;

  const handleOne = async (uuid: string, retried: boolean): Promise<void> => {
    const entry = taskByScene.get(uuid)!;
    const { scene, imagePath } = entry;
    try {
      const final = await pollHistory(key, uuid, `Geminigen #${scene.index}`);
      const img = final.generated_image?.[0];
      if (final.status !== 2) {
        const errMsg = `${final.error_code ?? ""} ${final.error_message ?? img?.error_message ?? "no result"}`.trim();
        // Auto-retry once on transient upstream Gemini throttling. The error message says
        // "If it still doesn't work, come back in 10 minutes" so a generous backoff is needed.
        if (!retried && final.error_code === "GEMINI_RATE_LIMIT") {
          console.warn(`[Geminigen] scene ${scene.index} hit GEMINI_RATE_LIMIT — resubmitting after 90s`);
          await new Promise((r) => setTimeout(r, 90_000));
          try {
            const sceneRefs = resolver ? (await resolver(scene.index, scene.imagePrompt)).slice(0, 5) : refPaths;
            const { uuid: newUuid } = await postGenerateImageRetry(key, scene.imagePrompt, sceneRefs, model, scene.index);
            taskByScene.set(newUuid, entry);
            taskByScene.delete(uuid);
            return handleOne(newUuid, true);
          } catch (err) {
            const m = (err as Error).message;
            console.warn(`[Geminigen] scene ${scene.index} resubmit failed:`, m);
            out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
            options.onImageFailed?.(scene.index, m);
            return;
          }
        }
        console.warn(`[Geminigen] scene ${scene.index} failed: ${errMsg}`);
        out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
        options.onImageFailed?.(scene.index, errMsg);
      } else {
        const url = pickImageUrl(img);
        if (!url) {
          console.warn(`[Geminigen] scene ${scene.index} completed but no URL — generated_image[0]=${JSON.stringify(img).slice(0, 200)}`);
          out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
          options.onImageFailed?.(scene.index, "completed but no URL");
        } else {
          await downloadToFile(url, imagePath);
          const result: ImageResult = { sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt };
          out.push(result);
          options.onImageReady?.(result);
        }
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      console.warn(`[Geminigen] scene ${scene.index} poll/download failed:`, errMsg);
      out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
      options.onImageFailed?.(scene.index, errMsg);
    }
    done += 1;
    onProgress(scenes.length + done, scenes.length * 2);
  };

  // True worker-pool : POLL_CONC slots, each pulls the next uuid as soon as it frees.
  // → images stream into onImageReady as fast as the provider delivers them, no batch waiting.
  const queue = Array.from(taskByScene.keys());
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(POLL_CONC, queue.length) }, async () => {
      while (cursor < queue.length) {
        const i = cursor++;
        if (i >= queue.length) return;
        await handleOne(queue[i], false);
      }
    }),
  );

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}

/** Generate a single thumbnail. Matches genaipro.generateThumbnail signature. */
export async function generateThumbnail(
  prompt: string,
  outputPath: string,
  referenceImagePaths: string[] = [],
): Promise<ImageResult> {
  const results = await generateImages(
    [{ index: 0, imagePrompt: prompt }],
    path.dirname(outputPath),
    () => { /* no-op */ },
    { referenceImagePaths },
  );
  if (results.length === 0 || !results[0].imagePath) {
    throw new Error("Geminigen thumbnail: no result");
  }
  return results[0];
}
