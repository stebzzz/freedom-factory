/**
 * lib/api/seedance.ts — animation I2V via WaveSpeed bytedance/seedance-v1-pro-fast.
 *
 * Drop-in replacement for GenAIPro / WAN `animateImages` : MEME signature, MEME contrat
 * (retourne des AnimationResult, fallback mock si pas de clé ou échec).
 *
 * Porté depuis scripts/lib-wan-image.mjs (generateI2VClip) — la pipeline `.mjs` historique
 * utilisait déjà ce modèle. On le rend disponible côté pipeline TS pour le combo
 * FlowMax (images) → Seedance (animation).
 */
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { AnimationResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

const WAVESPEED_BASE = "https://api.wavespeed.ai";
const I2V_PATH = "/api/v3/bytedance/seedance-v1-pro-fast/image-to-video";
const RESULT_PATH = (reqId: string) => `/api/v3/predictions/${reqId}/result`;

const POLL_INTERVAL_MS = 3000;
const I2V_TIMEOUT_MS = 10 * 60 * 1000; // 10 min par clip
const DEFAULT_DURATION = 5; // seedance pro-fast sort ~5s

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mimeFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function imageToDataUri(imagePath: string): Promise<string> {
  const buf = await readFile(imagePath);
  return `data:${mimeFor(imagePath)};base64,${buf.toString("base64")}`;
}

/** Soumet une image + motion prompt, poll jusqu'à completion, renvoie l'URL vidéo. */
async function animateOne(
  key: string,
  imagePath: string,
  motionPrompt: string,
  sceneIndex: number,
): Promise<string> {
  const dataUri = await imageToDataUri(imagePath);
  const submit = await fetch(`${WAVESPEED_BASE}${I2V_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ image: dataUri, prompt: motionPrompt }),
  });
  if (!submit.ok) {
    const body = await submit.text();
    throw new Error(`seedance submit ${submit.status}: ${body.slice(0, 300)}`);
  }
  const submitData = (await submit.json()) as { data?: { id?: string } };
  const requestId = submitData.data?.id;
  if (!requestId) throw new Error(`seedance scene ${sceneIndex}: pas d'id (${JSON.stringify(submitData).slice(0, 200)})`);

  const deadline = Date.now() + I2V_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${WAVESPEED_BASE}${RESULT_PATH(requestId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = (await res.json()) as {
      data?: { status?: string; outputs?: string[]; error?: string };
      status?: string;
      outputs?: string[];
      error?: string;
    };
    const inner = data.data ?? data;
    if (inner.status === "completed") {
      const videoUrl = inner.outputs?.[0];
      if (!videoUrl) throw new Error(`seedance scene ${sceneIndex}: completed mais pas d'URL vidéo`);
      return videoUrl;
    }
    if (inner.status === "failed") {
      throw new Error(`seedance scene ${sceneIndex} failed: ${inner.error || "unknown"}`);
    }
    // created / processing → on continue à poller
  }
  throw new Error(`seedance scene ${sceneIndex} timeout après ${I2V_TIMEOUT_MS / 1000}s`);
}

async function animateOneRetry(
  key: string,
  imagePath: string,
  motionPrompt: string,
  sceneIndex: number,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await animateOne(key, imagePath, motionPrompt, sceneIndex);
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      const transient = /Throttling|RateLimit|TooManyRequests|429|5\d\d|fetch failed|ECONN|ETIMEDOUT|timeout/i.test(msg);
      if (!transient || attempt === 3) throw lastErr;
      const delay = attempt * 5000;
      console.warn(`[Seedance] scene ${sceneIndex} retry ${attempt}/3 in ${delay}ms: ${msg.slice(0, 140)}`);
      await sleep(delay);
    }
  }
  throw lastErr ?? new Error("Seedance: retries épuisés");
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`seedance download ${res.status} pour ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

/**
 * Drop-in remplaçant de GenAIPro / WAN `animateImages`. Même signature/contrat.
 * Anime chaque image (1 clip par scène) via WaveSpeed seedance-v1-pro-fast.
 */
export async function animateImages(
  images: Array<{ imagePath: string; sceneIndex: number; motionPrompt?: string }>,
  outputDir: string,
  scenes: Array<{ durationSeconds: number }>,
  onProgress: (done: number, total: number) => void,
  options: { concurrency?: number } = {},
): Promise<AnimationResult[]> {
  const concurrency = options.concurrency ?? 6;

  const config = await getConfig();
  const key = (config as unknown as { wavespeedKey?: string }).wavespeedKey || process.env.WAVESPEED_API_KEY || "";
  if (!key) {
    console.warn("[Seedance] no WaveSpeed key — returning mock clips");
    return images.map((img) => ({
      sceneIndex: img.sceneIndex,
      clipPath: img.imagePath,
      durationSeconds: scenes[img.sceneIndex]?.durationSeconds ?? DEFAULT_DURATION,
      isMock: true,
    }));
  }

  console.log(`[Seedance] ${images.length} clips (model=seedance-v1-pro-fast, concurrency=${concurrency})`);
  const out: AnimationResult[] = [];
  let done = 0;
  const total = images.length;

  for (let i = 0; i < images.length; i += concurrency) {
    const batch = images.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (img) => {
        const sceneDur = scenes[img.sceneIndex]?.durationSeconds ?? DEFAULT_DURATION;
        const clipPath = path.join(outputDir, `clip_${String(img.sceneIndex).padStart(3, "0")}.mp4`);
        const motion = img.motionPrompt?.trim() || "Slow cinematic camera movement, smooth pan, gentle drift";
        try {
          const url = await animateOneRetry(key, img.imagePath, motion, img.sceneIndex);
          await downloadToFile(url, clipPath);
          out.push({ sceneIndex: img.sceneIndex, clipPath, durationSeconds: DEFAULT_DURATION });
        } catch (err) {
          console.warn(`[Seedance] scene ${img.sceneIndex} failed: ${(err as Error).message}`);
          out.push({ sceneIndex: img.sceneIndex, clipPath: img.imagePath, durationSeconds: sceneDur, isMock: true });
        }
        done += 1;
        onProgress(done, total);
      }),
    );
  }

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}
