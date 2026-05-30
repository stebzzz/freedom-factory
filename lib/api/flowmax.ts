import { writeFile } from "fs/promises";
import path from "path";
import { ImageResult } from "@/lib/pipeline/types";
import { getConfig } from "@/lib/config";

// FlowMax — Image generation provider backed by the REAL Google Flow (labs.google)
// driven by the FlowMax worker extensions, orchestrated by the FlowMax server.
//
// Flux :
//   POST  {server}/api/batch        body [{ prompt, style_name }]  → { batchId }
//   GET   {server}/api/batch/:id    → { complete, items:[{ index, status, result, error }] }
//                                     result = { media: [<url googleusercontent>], ... }
// Auth : header `X-API-Key: <key>` (si le serveur a une API_KEY).
//
// La référence d'image (@) se fait par NOM : `style_name` doit correspondre à une
// image DÉJÀ IMPORTÉE dans le compte Flow (style-kit). Format de prompt FlowMax :
//   "texte du prompt | NomDuStyle"  → prompt = avant le dernier "|", style = après.
// Sans "|", on retombe sur le basename de la 1ʳᵉ référence du pipeline.

const POLL_INTERVAL_MS = 8_000;
const POLL_TIMEOUT_MS = 45 * 60 * 1000; // batch entier (plusieurs workers + cooldowns)
const NO_WORKER_GRACE_MS = 90_000; // si 0 worker en ligne au-delà → on abandonne

interface FlowmaxItem {
  taskId: string;
  index: number;
  prompt: string;
  styleName: string | null;
  status: "pending" | "assigned" | "done" | "error";
  result: { media?: string[] } | null;
  error: string | null;
}

interface FlowmaxBatchStatus {
  batchId: string;
  total: number;
  done: number;
  failed: number;
  pending: number;
  complete: boolean;
  items: FlowmaxItem[];
  workersOnline?: number;
}

async function loadServer(): Promise<{ baseUrl: string; apiKey: string }> {
  const config = await getConfig();
  const c = config as unknown as { flowmaxServerUrl?: string; flowmaxApiKey?: string };
  const baseUrl = (process.env.FLOWMAX_SERVER_URL || c.flowmaxServerUrl || "").replace(/\/+$/, "");
  const apiKey = process.env.FLOWMAX_API_KEY || c.flowmaxApiKey || "";
  if (!baseUrl) throw new Error("FLOWMAX_SERVER_URL manquante (env ou config)");
  return { baseUrl, apiKey };
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { "X-API-Key": apiKey } : {};
}

async function downloadToFile(url: string, outputPath: string, attempts = 4): Promise<number> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error(`fichier vide (${buf.length}o)`);
      await writeFile(outputPath, buf);
      return buf.length;
    } catch (e) {
      lastErr = e as Error;
      // Erreurs transitoires (throttle CDN Google) → retry avec backoff 1s/2s/4s.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error(`download échec après ${attempts} essais (${lastErr?.message}): ${outputPath}`);
}

/** Dérive le `style_name` Flow (@) à partir d'un chemin de référence local.
 *  On enlève l'extension : le @nom Flow est sans extension (ex: alphonse.png → "alphonse").
 *  Le nom du fichier uploadé EST la référence — il doit matcher une image importée dans Flow. */
function refNameFromPath(p: string | undefined): string | null {
  if (!p) return null;
  return path.basename(p, path.extname(p));
}

/**
 * Parsing SPÉCIFIQUE FlowMax du format de prompt : "texte du prompt | NomDuStyle".
 * Le segment après le DERNIER "|" est le nom de l'image de style (déjà importée
 * dans Flow → mention @). On envoie la partie gauche comme prompt et la droite
 * comme `style_name`. Sans "|", on retombe sur le basename de la 1ʳᵉ référence.
 */
function parseFlowmaxPrompt(
  imagePrompt: string,
  refPaths: string[],
): { prompt: string; styleName: string | null } {
  const idx = imagePrompt.lastIndexOf("|");
  if (idx !== -1) {
    const prompt = imagePrompt.slice(0, idx).trim();
    const styleName = imagePrompt.slice(idx + 1).trim().replace(/^@/, "");
    return { prompt: prompt || imagePrompt.trim(), styleName: styleName || null };
  }
  return { prompt: imagePrompt.trim(), styleName: refNameFromPath(refPaths[0]) };
}

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
    model?: string;
  } = {},
): Promise<ImageResult[]> {
  const refPaths = options.referenceImagePaths ?? [];
  const resolver = options.resolveRefsForScene;

  let baseUrl: string;
  let apiKey: string;
  try {
    ({ baseUrl, apiKey } = await loadServer());
  } catch {
    console.warn("[FlowMax] no server URL — returning mock images");
    return scenes.map((s) => ({
      sceneIndex: s.index,
      imagePath: `${outputDir}/scene_${String(s.index).padStart(3, "0")}.jpg`,
      prompt: s.imagePrompt,
    }));
  }

  // 1) Construit les tâches (prompt + réf @ par nom) dans l'ordre des scènes.
  //    submitted[i] = la scène soumise en position i (= l'`index` renvoyé par le serveur).
  const submitted: Array<{ scene: typeof scenes[number]; imagePath: string }> = [];
  const tasks: Array<{ prompt: string; style_name: string | null }> = [];
  for (const scene of scenes) {
    const refs = resolver ? await resolver(scene.index, scene.imagePrompt) : refPaths;
    // Format FlowMax : "prompt | NomDuStyle" (style-kit importé dans Flow).
    const { prompt, styleName } = parseFlowmaxPrompt(scene.imagePrompt, refs);
    tasks.push({ prompt, style_name: styleName });
    submitted.push({
      scene,
      imagePath: `${outputDir}/scene_${String(scene.index).padStart(3, "0")}.jpg`,
    });
  }
  console.log(`[FlowMax] ${tasks.length} images via ${baseUrl} (refs=${tasks.some((t) => t.style_name) ? "yes" : "no"})`);

  // 2) POST du batch.
  const postRes = await fetch(`${baseUrl}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(tasks),
  });
  if (!postRes.ok) {
    const txt = await postRes.text().catch(() => "");
    throw new Error(`FlowMax /api/batch ${postRes.status}: ${txt.slice(0, 200)}`);
  }
  const { batchId } = (await postRes.json()) as { batchId: string };
  console.log(`[FlowMax] batch ${batchId} soumis`);

  // 3) Poll jusqu'à complétion. On télécharge + émet chaque image dès qu'elle est prête.
  const out: ImageResult[] = [];
  const handled = new Set<number>(); // index de tâche déjà traités
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let noWorkerSince = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let status: FlowmaxBatchStatus;
    try {
      const r = await fetch(`${baseUrl}/api/batch/${batchId}`, { headers: authHeaders(apiKey) });
      if (!r.ok) throw new Error(`status ${r.status}`);
      status = (await r.json()) as FlowmaxBatchStatus;
    } catch (e) {
      console.warn(`[FlowMax] poll échoué:`, (e as Error).message);
      continue;
    }

    // Abandon si aucun worker en ligne pendant trop longtemps (rien ne progressera).
    if (typeof status.workersOnline === "number" && status.workersOnline === 0 && status.done + status.failed < status.total) {
      if (!noWorkerSince) noWorkerSince = Date.now();
      else if (Date.now() - noWorkerSince > NO_WORKER_GRACE_MS) {
        throw new Error("FlowMax : aucun worker en ligne (extension Chrome déconnectée ?)");
      }
    } else {
      noWorkerSince = 0;
    }

    for (const item of status.items) {
      if (handled.has(item.index)) continue;
      const entry = submitted[item.index];
      if (!entry) continue;
      const { scene, imagePath } = entry;

      if (item.status === "done") {
        handled.add(item.index);
        const url = item.result?.media?.[0];
        if (!url) {
          console.warn(`[FlowMax] scène ${scene.index} terminée sans URL média`);
          out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
          options.onImageFailed?.(scene.index, "terminée mais aucune URL média");
        } else {
          try {
            await downloadToFile(url, imagePath);
            const result: ImageResult = { sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt };
            out.push(result);
            options.onImageReady?.(result);
          } catch (e) {
            const msg = (e as Error).message;
            console.warn(`[FlowMax] scène ${scene.index} download KO:`, msg);
            out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
            options.onImageFailed?.(scene.index, msg);
          }
        }
      } else if (item.status === "error") {
        handled.add(item.index);
        const msg = item.error || "erreur de génération";
        console.warn(`[FlowMax] scène ${scene.index} échec:`, msg);
        out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
        options.onImageFailed?.(scene.index, msg);
      }
    }

    onProgress(handled.size, scenes.length);
    if (status.complete) break;
  }

  // Marque en échec ce qui n'a jamais abouti (timeout).
  for (let i = 0; i < submitted.length; i++) {
    if (handled.has(i)) continue;
    const { scene, imagePath } = submitted[i];
    console.warn(`[FlowMax] scène ${scene.index} non aboutie (timeout)`);
    out.push({ sceneIndex: scene.index, imagePath, prompt: scene.imagePrompt });
    options.onImageFailed?.(scene.index, "timeout FlowMax");
  }

  return out.sort((a, b) => a.sceneIndex - b.sceneIndex);
}
