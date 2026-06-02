import { mkdir, writeFile, cp, readFile, readdir, stat, unlink } from "fs/promises";
import path from "path";
import { PipelineJob, PipelineJobParams, PipelineStepName, PipelineStepEvent, AnimationResult, ImageResult, ScriptScene } from "./types";
import { generateScript, extractCustomScriptWithPrompts, generateStickyPrompts, parseImagePromptsTxt, splitScriptInto2sScenes, generateScript2sScenes } from "@/lib/api/claude";
import { generateVoiceover, applyAudioSpeed, removeSilences } from "@/lib/api/voiceover";
import { findImageIssues } from "@/lib/api/claude-vision";
import { generateImages as generateImagesGenAIPro, generateThumbnail } from "@/lib/api/genaipro";
import { animateImages as animateImagesGenAIPro, generateT2VClip, generateIngredientsClip } from "@/lib/api/genaipro";
import { generateImages as generateImagesGeminigen } from "@/lib/api/geminigen";
import { generateImages as generateImagesWan, animateImages as animateImagesWan } from "@/lib/api/wan";
import { animateImages as animateImagesSeedance } from "@/lib/api/seedance";
import { generateImages as generateImagesFlowmax } from "@/lib/api/flowmax";
import { generateMusic } from "@/lib/api/music";
import { assembleMontage } from "@/lib/api/ffmpeg";
import { resolveRefsForScene as resolveKitRefs, resolveSplitRefsForScene, resolveSplitBriefForScene, getKit, buildDescribeKitMapping } from "@/lib/style-kit/import";
import { fetchTranscript, fetchThumbnail, detectLanguageFromText } from "@/lib/api/youtube";
import { rewriteCompetitorScript } from "@/lib/api/claude";
import { fetchArchivesForScenes } from "@/lib/api/archives";
import { alignScenesWithWhisper } from "@/lib/api/whisper";
import { getConfig } from "@/lib/config";
import { getPresetOrDefault } from "@/lib/presets/channel-presets";
import { syncJobToChannelFlow, markChannelFlowFailed, reportChannelFlowProgress, markChannelFlowPilotDone, writeChannelFlowMarker } from "@/lib/integrations/channelflow-sync";

// Global store — survit aux hot-reloads Turbopack en dev
declare global {
  // eslint-disable-next-line no-var
  var __ff_jobs: Map<string, PipelineJob> | undefined;
  // eslint-disable-next-line no-var
  var __ff_listeners: Map<string, Array<(event: PipelineStepEvent) => void>> | undefined;
}

const jobs: Map<string, PipelineJob> =
  global.__ff_jobs ?? (global.__ff_jobs = new Map());
const jobListeners: Map<string, Array<(event: PipelineStepEvent) => void>> =
  global.__ff_listeners ?? (global.__ff_listeners = new Map());

function generateId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getJob(id: string): PipelineJob | undefined {
  return jobs.get(id);
}

export function getAllJobs(): PipelineJob[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function subscribeToJob(id: string, listener: (event: PipelineStepEvent) => void): () => void {
  if (!jobListeners.has(id)) jobListeners.set(id, []);
  jobListeners.get(id)!.push(listener);
  return () => {
    const listeners = jobListeners.get(id);
    if (listeners) {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    }
  };
}

function imageUrlFor(jobId: string, imagePath: string): string {
  // imagePath is the absolute path on disk. We convert to the public URL served by Next.
  // Job dirs live under public/generated/<jobId>/, so we strip everything up to "generated/<jobId>".
  const marker = `/generated/${jobId}/`;
  const idx = imagePath.indexOf(marker);
  if (idx < 0) return `/generated/${jobId}/images/${path.basename(imagePath)}`;
  return imagePath.slice(idx);
}

function emit(jobId: string, event: PipelineStepEvent) {
  const job = jobs.get(jobId);
  if (job && event.step) {
    job.steps[event.step] = {
      status: event.status,
      progress: event.progress,
      message: event.message,
    };
    if (event.status === "running") job.currentStep = event.step;
  }
  // Progression temps réel vers ChannelFlow (no-op si pas de channelflowVideoId).
  if (job?.params.channelflowVideoId) void reportChannelFlowProgress(job, event);
  const listeners = jobListeners.get(jobId) || [];
  listeners.forEach((fn) => fn(event));
}

function samplePilotIndices(total: number, size = 5): number[] {
  if (total <= 0) return [];
  const n = Math.max(1, Math.min(size, total));
  if (n >= total) return Array.from({ length: total }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < n; i++) {
    const pos = n === 1 ? 0 : Math.round((i / (n - 1)) * (total - 1));
    out.add(pos);
  }
  for (let i = 0; out.size < n && i < total; i++) out.add(i);
  return [...out].sort((a, b) => a - b);
}

async function scanExistingOutputs(jobDir: string): Promise<{
  doneImages: Map<number, string>;
  doneClips: Map<number, string>;
}> {
  const imagesDir = path.join(jobDir, "images");
  const clipsDir = path.join(jobDir, "clips");
  const doneImages = new Map<number, string>();
  const doneClips = new Map<number, string>();
  try {
    for (const f of await readdir(imagesDir)) {
      const m = /^scene_(\d+)\.(png|jpe?g|webp)$/i.exec(f);
      if (m) doneImages.set(Number(m[1]), path.join(imagesDir, f));
    }
  } catch { /* dir missing — nothing to skip */ }
  try {
    for (const f of await readdir(clipsDir)) {
      const m = /^clip_(\d+)\.mp4$/i.exec(f);
      if (m) doneClips.set(Number(m[1]), path.join(clipsDir, f));
    }
  } catch { /* dir missing — nothing to skip */ }
  return { doneImages, doneClips };
}

function isEnabled(params: PipelineJobParams, step: string): boolean {
  const videoMode = params.videoMode ?? "t2v";
  const isStatic = videoMode === "static-images";
  // SCRIPT-ONLY: only the script step runs. Everything else stays out of the active step list
  // so the UI doesn't show ghost "queued" pills for steps that will never run.
  if (params.scriptOnly) {
    return step === "script";
  }
  // PILOT: only script + (images if mode needs them) + animation. Everything else (voiceover, archives, music, thumbnails, premium, bulk, montage) is OFF.
  if (params.pilotMode) {
    if (step === "script") return true;
    if (step === "images") return videoMode !== "t2v";
    if (step === "animation") return !isStatic;
    return false;
  }
  // script and montage are always required
  if (step === "script" || step === "montage") return true;
  // Explicit voiceover OFF takes precedence over everything else.
  if (step === "voiceover" && params.voiceoverEnabled === false) return false;
  // Explicit subtitles OFF wins over enabledSteps/preset defaults.
  if (step === "subtitles" && params.subtitlesEnabled === false) return false;
  if (step === "subtitles" && params.subtitlesEnabled === true) return true;
  // images: enabled for any non-t2v mode (i2v / ingredients / static-images).
  if (step === "images") return videoMode !== "t2v";
  // premium: only meaningful when images is OFF (the "premium" step regenerates key scenes).
  // When images is already enabled, premium is a no-op zombie → hide it from the step list.
  if (step === "premium") {
    if (videoMode === "t2v") return false;
    return !(["i2v", "ingredients", "static-images"].includes(videoMode));
  }
  // B-roll (bulk) is OFF by default — it doubles the image-gen cost for a redundant
  // "alternative perspective" variant that only pays off on slow Sleepy-style montages
  // with 6-10s per scene. Opt-in via enabledSteps.bulk === true.
  if (step === "bulk") {
    return params.enabledSteps?.bulk === true;
  }
  // static-images mode never runs the Veo animation step — Ken Burns is applied at montage.
  if (step === "animation") return !isStatic;
  // archives (Wikimedia/Pexels B-roll) is opt-in: it makes sense for documentary niches
  // but pollutes pure-stickman/explainer flows. Set enabledSteps.archives = true to enable.
  if (step === "archives") {
    return params.enabledSteps?.archives === true;
  }
  // Other steps (voiceover, music, subtitles, thumbnails) follow legacy enabledSteps if provided.
  if (params.enabledSteps) return params.enabledSteps[step] !== false;
  // Sensible defaults for new mode-based payload.
  return ["voiceover", "music", "subtitles", "thumbnails"].includes(step);
}

export async function startPipeline(params: PipelineJobParams): Promise<string> {
  const id = generateId();
  const jobDir = path.join(process.cwd(), "public", "generated", id);
  await mkdir(jobDir, { recursive: true });

  // Marqueur de liaison ChannelFlow : permet au re-concat (mode projet) de
  // resynchroniser la vidéo même hors du pipeline. No-op si pas de channelflowVideoId.
  writeChannelFlowMarker(jobDir, params.channelflowVideoId, params.channelflowChannelId);

  // Build initial steps based on what's enabled
  const allSteps: PipelineStepName[] = [
    "script",
    "voiceover",
    "images",
    "premium",
    "bulk",
    "archives",
    "animation",
    "music",
    "thumbnails",
    "montage",
  ];

  const activeSteps = allSteps.filter((s) => isEnabled(params, s));
  const initialSteps = Object.fromEntries(
    activeSteps.map((s) => [s, { status: "queued" as const, progress: 0, message: "En attente" }]),
  );

  const job: PipelineJob = {
    id,
    params,
    status: "queued",
    currentStep: null,
    steps: initialSteps,
    result: {},
    createdAt: new Date().toISOString(),
  };

  jobs.set(id, job);

  runPipeline(id, jobDir).catch((err) => {
    console.error(`[Pipeline] Job ${id} failed:`, err);
    const j = jobs.get(id)!;
    j.status = "failed";
    j.error = err.message;
    emit(id, { step: j.currentStep || "script", status: "failed", progress: 0, message: err.message });
    // Synchro retour ChannelFlow (no-op si pas de channelflowVideoId).
    void markChannelFlowFailed(j);
  });

  return id;
}

async function runPipeline(jobId: string, jobDir: string) {
  const job = jobs.get(jobId)!;
  const { params } = job;
  job.status = "running";

  // Load channel preset
  const preset = getPresetOrDefault(params.presetId);
  console.log(`[Pipeline] Preset: ${preset.label} (${preset.id})`);

  // --- Resume from pilot: copy clips/images + reuse pilot script ---
  let resumeImages = new Map<number, string>();
  let resumeClips = new Map<number, string>();
  if (params.resumeFromPilotId) {
    const srcDir = path.join(process.cwd(), "public", "generated", params.resumeFromPilotId);
    try { await cp(path.join(srcDir, "clips"), path.join(jobDir, "clips"), { recursive: true, force: false }); } catch { /* missing — fine */ }
    try { await cp(path.join(srcDir, "images"), path.join(jobDir, "images"), { recursive: true, force: false }); } catch { /* missing — fine */ }
    // Copy any pre-existing voiceover so the TTS step can skip itself (saves credits + time when audio was already produced or hand-provided).
    for (const fname of ["voiceover.wav", "voiceover.mp3"]) {
      try {
        await cp(path.join(srcDir, fname), path.join(jobDir, fname), { force: false });
        console.log(`[Pipeline] resume: réutilise ${fname} du pilot`);
      } catch { /* missing — fine */ }
    }
    if (!params.parsedScenes || params.parsedScenes.length === 0) {
      try {
        const txt = await readFile(path.join(srcDir, "script.json"), "utf-8");
        const data = JSON.parse(txt) as { scenes?: ScriptScene[] };
        if (Array.isArray(data?.scenes) && data.scenes.length > 0) {
          params.parsedScenes = data.scenes;
          console.log(`[Pipeline] resume: réutilise script.json du pilot (${data.scenes.length} scènes)`);
        }
      } catch (e) {
        console.warn(`[Pipeline] resume: script.json du pilot illisible:`, (e as Error).message);
      }
    }
    job.resumedFromPilotId = params.resumeFromPilotId;
    ({ doneImages: resumeImages, doneClips: resumeClips } = await scanExistingOutputs(jobDir));
    console.log(`[Pipeline] resume: ${resumeClips.size} clips + ${resumeImages.size} images réutilisés du pilot ${params.resumeFromPilotId}`);
  }

  // --- Competitor replication (optional) ---
  // When competitorVideoUrl is set, fetch the YouTube thumbnail (always) and, if
  // rewriteCompetitorScript is true, fetch + rewrite the transcript into customScript
  // BEFORE the script step decides what to do. Failures are non-blocking: we fall
  // back to vanilla Claude script generation.
  let competitorThumbPath: string | undefined;
  if (params.competitorVideoUrl?.trim()) {
    const url = params.competitorVideoUrl.trim();
    try {
      emit(jobId, { step: "script", status: "running", progress: 2,
        message: "Téléchargement miniature concurrent..." });
      const thumbDest = path.join(jobDir, "competitor_thumb.jpg");
      competitorThumbPath = await fetchThumbnail(url, thumbDest);
      console.log(`[Pipeline] competitor thumbnail saved → ${competitorThumbPath}`);
    } catch (err) {
      console.warn(`[Pipeline] competitor thumbnail fetch failed (non-blocking):`, (err as Error).message);
    }

    if (params.rewriteCompetitorScript === true) {
      try {
        emit(jobId, { step: "script", status: "running", progress: 4,
          message: "Téléchargement transcript concurrent..." });
        const transcript = await fetchTranscript(url);
        emit(jobId, { step: "script", status: "running", progress: 6,
          message: `Réécriture script (~20%) — ${transcript.split(/\s+/).length} mots source...` });
        const rewritten = await rewriteCompetitorScript(transcript, params.title, params.niche, params.duration);
        params.customScript = rewritten;
        console.log(`[Pipeline] competitor rewrite: ${rewritten.split(/\s+/).length} mots → customScript`);
      } catch (err) {
        console.warn(`[Pipeline] competitor transcript/rewrite failed (fallback Claude vanilla):`, (err as Error).message);
        emit(jobId, { step: "script", status: "running", progress: 6,
          message: `Rewrite échec: ${(err as Error).message.slice(0, 80)} — fallback script vanilla` });
      }
    }
  }

  // --- Step 1: Script (always) ---
  const hasParsedScenes = params.parsedScenes && params.parsedScenes.length > 0;
  const hasCustomScript = params.customScript && params.customScript.trim().length > 20;
  // Sticky mode: video is a slideshow (static-images) and the user provided BOTH a script and a style brief.
  // The customStyle field is then treated as a meta-prompt for Claude (instructions for generating image prompts),
  // not as a per-image suffix. Avoids JSON.parse entirely by using the text-format IMAGE N — MM:SS–MM:SS.
  const stickyMode = params.videoMode === "static-images"
    && hasCustomScript
    && !!(params.customStyle && params.customStyle.trim())
    && params.customScriptHasImagePrompts !== true;

  // Describe-mode kit: when the selected style kit is `mode:describe`, override script gen
  // to produce EXACTLY 2s-per-scene segments with short stickman-action imagePrompts. The
  // ref images (picked by the kit's semantic matcher in the images step) carry the style.
  const legacySlugTop = params.styleKitSlug?.trim() || "";
  let describeKitActive = false;
  if (legacySlugTop && !hasParsedScenes) {
    try {
      const meta = await getKit(legacySlugTop);
      if (meta?.mode === "describe") describeKitActive = true;
    } catch (err) {
      console.warn(`[Pipeline] kit meta lookup failed (non-blocking):`, (err as Error).message);
    }
  }

  let script;

  if (hasParsedScenes) {
    // Pre-parsed scenes from standalone script — skip Claude entirely
    emit(jobId, { step: "script", status: "running", progress: 50, message: "Scenes pre-parsees importees..." });
    const scenes = params.parsedScenes!;
    const fullScript = scenes.map((s) => s.narration).join("\n\n");
    script = { fullScript, scenes, wordCount: fullScript.split(/\s+/).length };
    console.log(`[Pipeline] Scenes pre-parsees: ${scenes.length} scenes, skip Claude`);
  } else if (stickyMode) {
    emit(jobId, { step: "script", status: "running", progress: 10,
      message: "Mode sticky — Claude génère les prompts à partir du style + script..." });
    script = await generateStickyPrompts(
      params.customScript!,
      params.customStyle!.trim(),
      params.duration,
    );
    console.log(`[Pipeline] Sticky: ${script.scenes.length} images générées via Claude + style brief`);
  } else if (describeKitActive) {
    // Describe-kit flow: scenes adaptive ~1.5s, leveraging the kit's image prompts as visual vocabulary.
    // Narration language follows the SOURCE video of the kit (not the `voix` param) — a kit built
    // from an English YouTube video produces English narration even with a male-fr voice.
    let kitVocab: string[] = [];
    let kitLanguage: "en" | "fr" | undefined;
    let kitSourceUrl: string | undefined;
    try {
      const meta = await getKit(legacySlugTop);
      kitVocab = [...(meta?.character ?? []), ...(meta?.style ?? [])]
        .map((i) => i.imagePrompt?.trim())
        .filter((p): p is string => !!p && p.length > 20);
      kitLanguage = meta?.narrationLanguage;
      kitSourceUrl = meta?.sourceUrl;
    } catch (err) {
      console.warn(`[Pipeline] kit vocab load failed (non-blocking):`, (err as Error).message);
    }
    if (!kitLanguage && kitSourceUrl) {
      // Cache miss: detect from a quick transcript fetch, persist back into kit meta.
      try {
        emit(jobId, { step: "script", status: "running", progress: 5, message: "Détection langue source vidéo..." });
        const transcript = await fetchTranscript(kitSourceUrl);
        kitLanguage = detectLanguageFromText(transcript);
        if (kitLanguage) {
          const kitsRoot = path.join(process.cwd(), "public/style-refs", legacySlugTop, "meta.json");
          try {
            const raw = await readFile(kitsRoot, "utf-8");
            const meta = JSON.parse(raw);
            meta.narrationLanguage = kitLanguage;
            await writeFile(kitsRoot, JSON.stringify(meta, null, 2));
            console.log(`[Pipeline] kit '${legacySlugTop}' langue détectée=${kitLanguage}, cached`);
          } catch (err) {
            console.warn(`[Pipeline] kit meta cache write failed (non-blocking):`, (err as Error).message);
          }
        }
      } catch (err) {
        console.warn(`[Pipeline] language detect failed (non-blocking, fallback voix):`, (err as Error).message);
      }
    }
    const language: "en" | "fr" = kitLanguage ?? (params.voix.includes("fr") ? "fr" : "en");
    // If the user provided a customScript, ALWAYS use it verbatim — ignore describeKitScriptSource.
    // Anything else would silently regenerate the script (the very thing the user complained about).
    const wantCustom = hasCustomScript;
    if (wantCustom && hasCustomScript) {
      // Pilot mode: pass the sample size so Claude only generates imagePrompts for the pilot
      // subset (5 by default) instead of all ~275 scenes. Cuts script gen from ~14 chunks to 1.
      const pilotForSplit = params.pilotMode ? (params.pilotSampleSize ?? 5) : undefined;
      emit(jobId, { step: "script", status: "running", progress: 10,
        message: params.pilotMode
          ? `Mode pilot (${language}) — Claude génère uniquement ${pilotForSplit} imagePrompts...`
          : `Mode describe-kit (${language}) — Claude découpe ton script en scènes ~1.5s...` });
      script = await splitScriptInto2sScenes(params.customScript!, params.duration, kitVocab, pilotForSplit, jobId);
    } else {
      emit(jobId, { step: "script", status: "running", progress: 10,
        message: `Mode describe-kit (${language}) — Claude génère script + scènes ~1.5s...` });
      script = await generateScript2sScenes(params.title, params.niche, params.description, params.duration, language, kitVocab);
    }
    console.log(`[Pipeline] Describe-kit: ${script.scenes.length} scènes adaptive ~1.5s (vocab ${kitVocab.length} refs, lang=${language})`);
  } else if (hasCustomScript) {
    const extractMode = params.customScriptHasImagePrompts === true;
    emit(jobId, { step: "script", status: "running", progress: 10,
      message: extractMode ? "Extraction script + image prompts..." : "Analyse du script custom..." });
    if (extractMode) {
      // Try the synchronous regex parser first — if the user's text already follows the
      // IMAGE N — MM:SS–MM:SS format, we skip Claude entirely (no API call, no JSON.parse risk).
      try {
        script = parseImagePromptsTxt(params.customScript!, params.duration * 60);
        console.log(`[Pipeline] Extract: parser regex direct (no Claude call) — ${script.scenes.length} scenes`);
      } catch (e) {
        console.log(`[Pipeline] Extract: regex parser failed (${(e as Error).message}), fallback Claude`);
        script = await extractCustomScriptWithPrompts(
          params.customScript!,
          params.title,
          params.niche,
          params.duration,
          params.presetId,
        );
      }
    } else {
      // Script custom SANS image-prompts inline. On N'utilise PLUS parseCustomScript :
      // il envoyait tout le script en UN seul appel à Claude qui dépassait le timeout
      // de 5 min du wrapper VPS sur les longs scripts (→ "ÉCHEC après 3 tentatives:
      // operation aborted due to timeout", reproduit sur les jobs animal le 02/06).
      // splitScriptInto2sScenes découpe la narration en JS PUR (verbatim garanti, avec
      // une garde qui throw si la narration diverge ne serait-ce que d'un caractère) et
      // ne demande à Claude QUE les imagePrompts, par batches de 20 → plus de timeout,
      // script jamais modifié.
      let kitVocab: string[] = [];
      if (legacySlugTop) {
        try {
          const meta = await getKit(legacySlugTop);
          kitVocab = [...(meta?.character ?? []), ...(meta?.style ?? [])]
            .map((i) => i.imagePrompt?.trim())
            .filter((p): p is string => !!p && p.length > 20);
        } catch (err) {
          console.warn(`[Pipeline] kit vocab load failed (non-blocking):`, (err as Error).message);
        }
      }
      const pilotForSplit = params.pilotMode ? (params.pilotSampleSize ?? 5) : undefined;
      emit(jobId, { step: "script", status: "running", progress: 10,
        message: pilotForSplit
          ? `Mode pilot — Claude génère ${pilotForSplit} imagePrompts (script verbatim)...`
          : "Découpe JS verbatim + imagePrompts par batches (script intact)..." });
      script = await splitScriptInto2sScenes(params.customScript!, params.duration, kitVocab, pilotForSplit, jobId);
    }
  } else {
    emit(jobId, { step: "script", status: "running", progress: 10, message: `Script ${preset.label}...` });
    script = await generateScript(
      params.title,
      params.niche,
      params.description,
      params.duration,
      params.voix,
      params.presetId,
    );
  }

  job.result.script = script;

  // Export script as .txt + .json
  await writeFile(
    path.join(jobDir, "script.txt"),
    script.scenes.map((s, i) => `--- Scene ${i + 1} ---\n${s.narration}`).join("\n\n"),
  );
  await writeFile(
    path.join(jobDir, "script.json"),
    JSON.stringify({
      title: params.title,
      niche: params.niche,
      wordCount: script.wordCount,
      scenes: script.scenes,
      // Persist the model choices so /api/projects/.../scenes/[id] knows which
      // provider to call when the user clicks "Regen image" later.
      imageProvider: params.imageProvider ?? "genaipro",
      wanModel: params.wanModel,
      geminigenModel: params.geminigenModel,
    }, null, 2),
  );
  console.log(`[Pipeline] Script exporte: ${jobDir}/script.txt + script.json`);

  // --- scriptOnly: stop right after the script step + refs mapping is exported. ---
  // The user wants to audit the imagePrompts AND the refs picked per scene before launching the
  // costly WAN gen. So we also run the describe-kit semantic ranking + anti-duplicate + canonical
  // stick attachment here, then export refs-mapping.json, then stop.
  if (params.scriptOnly) {
    const slug = params.styleKitSlug?.trim() || "";
    if (slug) {
      try {
        const kitMeta = await getKit(slug);
        if (kitMeta?.mode === "describe") {
          emit(jobId, { step: "script", status: "running", progress: 70,
            message: `Ranking refs (Claude) sur kit '${slug}'...` });
          // top-10 candidates + hard cap on reuse → maximize variety across the kit
          const candidateMap = await buildDescribeKitMapping(
            slug,
            script.scenes.map((s) => ({ index: s.index, imagePrompt: s.imagePrompt })),
            10,
          );
          if (candidateMap) {
            const finalMap = new Map<number, string[]>();
            const usageCount = new Map<string, number>();
            let prevPick: string | null = null;
            // Canonical = pure stickman (frame-005) — no scenery anchor for style consistency.
            const canonicalStickPath = path.join(process.cwd(), "public", "style-refs", slug, "style", "frame-005.png");
            let canonicalStickExists = false;
            try { await stat(canonicalStickPath); canonicalStickExists = true; } catch { /* not present */ }
            // Compute the cap dynamically so we have enough budget across scenes
            const allRefPaths = new Set<string>();
            for (const cs of candidateMap.values()) cs.forEach((p) => allRefPaths.add(p));
            const MAX_REUSE = Math.max(2, Math.ceil(script.scenes.length / Math.max(1, allRefPaths.size)) + 1);

            for (const s of script.scenes) {
              const candidates = candidateMap.get(s.index) ?? [];
              if (candidates.length === 0) {
                const wantsStick = /stickman|stick figure/i.test(s.imagePrompt);
                finalMap.set(s.index, wantsStick && canonicalStickExists ? [canonicalStickPath] : []);
                continue;
              }
              const allowed = candidates.filter((c) => c !== prevPick && (usageCount.get(c) ?? 0) < MAX_REUSE);
              const pool = allowed.length > 0
                ? allowed
                : candidates.filter((c) => c !== prevPick).length > 0
                  ? candidates.filter((c) => c !== prevPick)
                  : candidates;
              let best = pool[0];
              let bestUsage = usageCount.get(best) ?? 0;
              for (let i = 1; i < pool.length; i++) {
                const u = usageCount.get(pool[i]) ?? 0;
                if (u < bestUsage) { best = pool[i]; bestUsage = u; }
              }
              const wantsStick = /stickman|stick figure/i.test(s.imagePrompt);
              const refList = (canonicalStickExists && wantsStick && best !== canonicalStickPath)
                ? [canonicalStickPath, best]
                : [best];
              finalMap.set(s.index, refList);
              usageCount.set(best, (usageCount.get(best) ?? 0) + 1);
              prevPick = best;
            }

            const publicPrefix = path.join(process.cwd(), "public") + path.sep;
            const toPublicUrl = (absPath: string) =>
              absPath.startsWith(publicPrefix) ? "/" + absPath.slice(publicPrefix.length).split(path.sep).join("/") : absPath;
            const mappingRows = script.scenes.map((s) => {
              const picked = finalMap.get(s.index) ?? [];
              const candidates = candidateMap.get(s.index) ?? [];
              return {
                sceneIndex: s.index,
                narration: s.narration,
                imagePrompt: s.imagePrompt,
                refs: picked.map((p) => ({ filename: path.basename(p), url: toPublicUrl(p) })),
                candidates: candidates.map((p) => ({ filename: path.basename(p), url: toPublicUrl(p) })),
              };
            });
            await writeFile(
              path.join(jobDir, "refs-mapping.json"),
              JSON.stringify({ kit: slug, topN: 10, antiDuplicate: true, maxReuse: MAX_REUSE, canonicalStick: canonicalStickExists, scenes: mappingRows }, null, 2),
            );
            const hits = Array.from(finalMap.values()).filter((p) => p.length > 0).length;
            const usedRefs = new Set([...usageCount.keys()]).size;
            const maxObservedUse = Math.max(0, ...usageCount.values());
            console.log(`[Pipeline] scriptOnly mapping: ${hits}/${script.scenes.length} scènes, ${usedRefs} refs uniques (max ${maxObservedUse}× / cap ${MAX_REUSE}×), canonical=${canonicalStickExists}`);
          }
        }
      } catch (err) {
        console.warn(`[Pipeline] scriptOnly refs mapping failed (non-blocking): ${(err as Error).message}`);
      }
    }
    emit(jobId, { step: "script", status: "completed", progress: 100,
      message: `${script.scenes.length} scènes prêtes — scriptOnly stop` });
    job.status = "completed";
    job.currentStep = null;
    console.log(`[Pipeline] scriptOnly: ${script.scenes.length} scènes exportées, pipeline arrêté avant images.`);
    return;
  }

  // --- Pilot subset + resume skip set ---
  const isPilot = params.pilotMode === true;
  const pilotSize = params.pilotSampleSize ?? 5;
  let pilotSet: Set<number> | null = null;
  if (isPilot) {
    const positions = samplePilotIndices(script.scenes.length, pilotSize);
    const indices = positions.map((p) => script.scenes[p].index);
    job.pilotIndices = indices;
    pilotSet = new Set(indices);
    console.log(`[Pipeline] PILOT: ${indices.length} scènes (indices ${indices.join(", ")})`);
  }
  emit(jobId, {
    step: "script",
    status: "completed",
    progress: 100,
    message: isPilot
      ? `${script.wordCount} mots · pilot ${job.pilotIndices?.length ?? 0}/${script.scenes.length} scènes`
      : `${script.wordCount} mots, ${script.scenes.length} scenes`,
  });

  const imageScenes = script.scenes.filter((s) => {
    if (pilotSet && !pilotSet.has(s.index)) return false;
    if (resumeImages.has(s.index)) return false;
    return true;
  });
  const animationScenes = script.scenes.filter((s) => {
    if (pilotSet && !pilotSet.has(s.index)) return false;
    if (resumeClips.has(s.index)) return false;
    return true;
  });

  const reusedImages: ImageResult[] = [...resumeImages.entries()].map(([idx, p]) => ({
    sceneIndex: idx,
    imagePath: p,
    prompt: script.scenes.find((s) => s.index === idx)?.imagePrompt ?? "",
  }));
  const reusedClips: AnimationResult[] = [...resumeClips.entries()].map(([idx, p]) => ({
    sceneIndex: idx,
    clipPath: p,
    durationSeconds: script.scenes.find((s) => s.index === idx)?.durationSeconds ?? 8,
    isMock: false,
  }));

  // --- Thumbnail (en parallèle avec les steps lourds) ---
  // La thumbnail n'est utilisée par aucun autre step ; on la lance dès que le
  // script est prêt et on l'attend juste avant de marquer le job terminé.
  // Si elle échoue (modération Veo, 429, etc.) on continue sans — c'est non bloquant.
  let thumbnailPromise: Promise<void> | null = null;
  if (isEnabled(params, "thumbnails")) {
    emit(jobId, { step: "thumbnails", status: "running", progress: 10, message: "Generation thumbnail (parallele)..." });
    const thumbnailPath = path.join(jobDir, "thumbnail.png");
    // When a competitor thumbnail was downloaded, ask nano_banana to remake it
    // for our channel + our subject — feeding the source thumb as reference_image.
    // Otherwise fall back to a scene-derived prompt.
    const thumbnailPrompt = competitorThumbPath
      ? `Recreate this YouTube thumbnail style and composition for MY channel, on the subject: "${params.title}". Keep the layout, color hierarchy, focal point energy and emotional pull of the reference. Replace any text with my own (bold, max 4 words, derived from the subject). Adjust the subject/imagery to fit "${params.title}". 16:9, high contrast, eye-catching.`
      : script.scenes[0]?.imagePrompt
      ? `${script.scenes[0].imagePrompt}, YouTube thumbnail style, bold, eye-catching, high contrast, 16:9`
      : `${params.title}, YouTube thumbnail, cinematic, dramatic lighting, 16:9`;
    thumbnailPromise = generateThumbnail(thumbnailPrompt, thumbnailPath, competitorThumbPath ? [competitorThumbPath] : [])
      .then((thumbnail) => {
        job.result.thumbnails = { imagePath: thumbnail.imagePath, prompt: thumbnailPrompt };
        emit(jobId, { step: "thumbnails", status: "completed", progress: 100, message: "Thumbnail generee" });
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Pipeline] Thumbnail echouee, on continue sans:`, errMsg);
        emit(jobId, { step: "thumbnails", status: "failed", progress: 0, message: `Echec non bloquant: ${errMsg.slice(0, 80)}` });
      });
  }

  // --- Step 2: Voiceover ---
  // Voiceover failure is non-blocking: the pipeline continues to images and stops cleanly before montage.
  // When `voiceoverGate` is true, the runner pauses after each voiceover attempt and waits for an explicit
  // approve / regenerate / cancel decision before continuing.
  let voiceoverFailed = false;
  let voiceoverError: Error | null = null;
  // Voix off LANCÉE EN PARALLÈLE des images : le TTS GenAI prend ~40min, on ne bloque
  // plus la génération d'images/animation derrière. La promesse est AWAITée juste avant
  // le montage (qui a besoin de l'audio + des durations alignées Whisper).
  const voiceoverPromise: Promise<void> = (async () => {
    if (!isEnabled(params, "voiceover")) return;
    const audioPath = path.join(jobDir, "voiceover.wav");
    try {
      let attempt = 0;
      let gateApproved = false;
      while (!gateApproved) {
        attempt++;
        const voiceLabel =
          params.voiceModel === "elevenlabs" ? "ElevenLabs"
          : params.voiceModel === "fishspeech" ? "Fish Speech 1.5"
          : "ElevenLabs (GenAIPro)";
        emit(jobId, { step: "voiceover", status: "running", progress: 10,
          message: attempt === 1 ? `Synthese vocale ${voiceLabel}...` : `Re-génération voix off (#${attempt}) ${voiceLabel}...` });

        // On the FIRST attempt we may reuse an existing file (resumeFromPilotId or hand-provided audio).
        // On regenerate attempts we always re-call TTS (the user explicitly asked for a new take).
        let voiceover: { audioPath: string; durationSeconds: number } | undefined;
        if (attempt === 1) {
          for (const fname of ["voiceover.wav", "voiceover.mp3"]) {
            try {
              const p = path.join(jobDir, fname);
              const st = await stat(p);
              if (st.size > 0) {
                const estDur = Math.round(script.fullScript.split(/\s+/).length / 2.5);
                voiceover = { audioPath: p, durationSeconds: estDur };
                console.log(`[Pipeline] voiceover existant détecté (${fname}, ${(st.size / 1024 / 1024).toFixed(1)} MB) — skip TTS`);
                emit(jobId, { step: "voiceover", status: "completed", progress: 100,
                  message: `Audio existant réutilisé (${fname})` });
                break;
              }
            } catch { /* not present */ }
          }
        }
        if (!voiceover) {
          voiceover = await generateVoiceover(script.fullScript, params.voix, audioPath, {
            voiceModel: params.voiceModel,
            genaiproTTSModel: params.genaiproTTSModel,
            voiceSpeed: params.voiceSpeed,
          });
        }
        job.result.voiceover = voiceover;

        // Post-TTS time-stretch (ffmpeg atempo) — runs BEFORE Whisper alignment so scene
        // durations stay coherent with the final audio file.
        if (params.audioSpeed && Math.abs(params.audioSpeed - 1) > 0.01) {
          try {
            emit(jobId, { step: "voiceover", status: "running", progress: 95,
              message: `atempo ×${params.audioSpeed.toFixed(2)}...` });
            const newDur = await applyAudioSpeed(voiceover.audioPath, params.audioSpeed);
            voiceover.durationSeconds = Math.round(newDur);
          } catch (err) {
            console.warn(`[Pipeline] atempo échoué, audio inchangé:`, (err as Error).message);
          }
        }

        // Suppression des silences (toujours actif) AVANT l'alignement Whisper,
        // pour que les durées de scènes soient calées sur l'audio nettoyé.
        try {
          emit(jobId, { step: "voiceover", status: "running", progress: 97, message: "Suppression des silences..." });
          const dur = await removeSilences(voiceover.audioPath);
          voiceover.durationSeconds = Math.round(dur);
        } catch (err) {
          console.warn(`[Pipeline] désilence échouée, audio inchangé:`, (err as Error).message);
        }

        emit(jobId, { step: "voiceover", status: "completed", progress: 100, message: `Audio ${voiceover.durationSeconds}s genere` });

        // --- Whisper alignment: align scene durations on the real voiceover timing ---
        if (params.alignWithWhisper !== false) {
          try {
            emit(jobId, { step: "voiceover", status: "running", progress: 100, message: "Alignement Whisper..." });
            const aligned = await alignScenesWithWhisper(script.scenes, voiceover.audioPath, {
              language: preset.language,
            });
            // Persist the aligned script.json so the montage and downstream consumers see the updated durations.
            await writeFile(
              path.join(jobDir, "script.json"),
              JSON.stringify({ title: params.title, niche: params.niche, wordCount: script.wordCount, scenes: script.scenes }, null, 2),
            );
            const matchPct = Math.round(aligned.matchedWordRatio * 100);
            console.log(`[Pipeline] Whisper alignement: ${aligned.totalAudioSec.toFixed(1)}s audio, ${matchPct}% mots matched`);
            emit(jobId, { step: "voiceover", status: "completed", progress: 100,
              message: `Audio ${voiceover.durationSeconds}s · aligné Whisper (${matchPct}% match)` });
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[Pipeline] Whisper alignement échoué, on garde les durations Claude:`, errMsg);
            emit(jobId, { step: "voiceover", status: "completed", progress: 100,
              message: `Audio ${voiceover.durationSeconds}s · alignement échec (durations Claude)` });
          }
        }

        // --- Human gate: pause for explicit approval before images start ---
        if (!params.voiceoverGate) {
          gateApproved = true;
          continue;
        }
        job.awaitingVoiceoverApproval = true;
        job.voiceoverDecision = undefined;
        job.voiceoverOverrides = undefined;
        const audioUrl = `/generated/${jobId}/${path.basename(voiceover.audioPath)}`;
        emit(jobId, { step: "voiceover", status: "running", progress: 100,
          message: "En attente de validation — écoute et choisis Valider / Refaire / Annuler.",
          data: { awaitingApproval: true, audioUrl, voix: params.voix, voiceModel: params.voiceModel, voiceSpeed: params.voiceSpeed } });
        console.log(`[Pipeline] voiceover gate — attente décision user (jobId=${jobId})`);
        while (!job.voiceoverDecision) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        const decision = job.voiceoverDecision;
        const overrides = job.voiceoverOverrides;
        job.awaitingVoiceoverApproval = false;
        job.voiceoverDecision = undefined;
        job.voiceoverOverrides = undefined;
        console.log(`[Pipeline] voiceover gate → decision="${decision}"${overrides ? ` overrides=${JSON.stringify(overrides)}` : ""}`);
        if (decision === "approve") {
          gateApproved = true;
        } else if (decision === "cancel") {
          throw new Error("Voiceover annulé par l'utilisateur au gate");
        } else if (decision === "regenerate") {
          if (overrides) {
            const o = overrides as {
              voix?: string;
              voiceModel?: "genaipro" | "elevenlabs" | "fishspeech";
              genaiproTTSModel?: "eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_flash_v2_5" | "eleven_v3";
              voiceSpeed?: number;
            };
            if (o.voix) params.voix = o.voix;
            if (o.voiceModel) params.voiceModel = o.voiceModel;
            if (o.genaiproTTSModel) params.genaiproTTSModel = o.genaiproTTSModel;
            if (typeof o.voiceSpeed === "number") params.voiceSpeed = o.voiceSpeed;
          }
          // Wipe existing audio so the next iteration regenerates from scratch (no skip-TTS).
          for (const fname of ["voiceover.wav", "voiceover.mp3"]) {
            try { await unlink(path.join(jobDir, fname)); } catch { /* not present, fine */ }
          }
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("annulé par l'utilisateur")) {
        // Hard cancel — propagate so the outer catch marks the job as failed cleanly.
        throw err;
      }
      console.warn(`[Pipeline] Voiceover échoué, on continue jusqu'aux images puis on stoppe avant montage:`, errMsg);
      voiceoverFailed = true;
      emit(jobId, { step: "voiceover", status: "failed", progress: 0,
        message: `Voix off échouée: ${errMsg.slice(0, 100)} — pipeline continue (images puis stop)` });
    }
  })().catch((e: unknown) => { voiceoverError = e instanceof Error ? e : new Error(String(e)); });

  // --- Step 3: Images principales (GenAIPro Veo) ---
  const imagesDir = path.join(jobDir, "images");
  await mkdir(imagesDir, { recursive: true });

  if (isEnabled(params, "images")) {
    emit(jobId, { step: "images", status: "running", progress: 5, message: "Generation images GenAIPro Veo..." });

    // Determine which scenes get premium treatment (same model — flag retained for future tier routing)
    const premiumScenes: number[] = [];
    if (isEnabled(params, "premium") && params.scenario === "A") {
      // Key scenes: hook (0), every 1/3, last
      const n = script.scenes.length;
      premiumScenes.push(0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1);
    }

    // Append visual style to every image prompt. Priority:
    //   customStyle (manual) > kit.styleBrief (auto from competitor video) > preset.imageStyleSuffix
    // EXCEPTION: in extract mode, sticky mode, or describe-kit mode the prompts already encode
    // everything we want — keep them verbatim and let refs carry the style.
    const skipStyleAppend = params.customScriptHasImagePrompts === true || stickyMode || describeKitActive;
    let kitStyleBrief = "";
    if (params.styleKitSlug?.trim()) {
      try {
        const kit = await getKit(params.styleKitSlug.trim());
        if (kit?.styleBrief?.trim()) kitStyleBrief = kit.styleBrief.trim();
      } catch (err) {
        console.warn(`[Pipeline] kit styleBrief load failed (non-blocking):`, (err as Error).message);
      }
    }
    const styleHint = skipStyleAppend
      ? ""
      : ((params.customStyle && params.customStyle.trim())
        || kitStyleBrief
        || preset.visual.imageStyleSuffix);
    if (!skipStyleAppend && kitStyleBrief && !params.customStyle?.trim()) {
      console.log(`[Pipeline] using kit styleBrief as customStyle fallback (${kitStyleBrief.length} chars)`);
    }
    const userRefs = (params.userRefImagePaths ?? []).slice(0, 5);
    const humanSlug = params.styleKitHumanSlug?.trim() || "";
    const objectSlug = params.styleKitObjectSlug?.trim() || "";
    const legacySlug = params.styleKitSlug?.trim() || "";

    // Describe-mode kit: ask Claude once to map each scene to its top-5 best-matching
    // kit images, then resolver becomes a pure lookup. Only kicks in when the selected
    // single kit is describe-mode AND no dual-kit slugs are set (those override).
    const dualMode = !!(humanSlug || objectSlug);
    let describeMap: Map<number, string[]> | null = null;
    if (!dualMode && legacySlug) {
      try {
        const legacyKitMeta = await getKit(legacySlug);
        if (legacyKitMeta?.mode === "describe") {
          // Resume shortcut: if the source dir has a refs-mapping.json (final picks already
          // computed by a previous scriptOnly run), reuse it directly — no Claude call needed.
          let reusedFromResume = false;
          if (params.resumeFromPilotId) {
            const srcMapping = path.join(process.cwd(), "public", "generated", params.resumeFromPilotId, "refs-mapping.json");
            try {
              const raw = await readFile(srcMapping, "utf-8");
              const data = JSON.parse(raw) as {
                scenes?: Array<{ sceneIndex: number; refs?: Array<{ filename: string; url: string }> }>;
              };
              if (Array.isArray(data.scenes) && data.scenes.length > 0) {
                const m = new Map<number, string[]>();
                const publicDir = path.join(process.cwd(), "public");
                for (const row of data.scenes) {
                  const paths = (row.refs ?? [])
                    .map((r) => r.url.startsWith("/") ? path.join(publicDir, r.url.slice(1)) : r.url)
                    .filter(Boolean);
                  m.set(row.sceneIndex, paths);
                }
                describeMap = m;
                // Persist a copy of the source mapping into the new jobDir for audit parity.
                try {
                  await writeFile(path.join(jobDir, "refs-mapping.json"), raw);
                } catch { /* non-blocking */ }
                console.log(`[Pipeline] resume: réutilise refs-mapping.json du pilot (${m.size} scènes, skip Claude ranking)`);
                emit(jobId, { step: "images", status: "running", progress: 8,
                  message: `Refs mapping réutilisé du pilot (${m.size} scènes)` });
                reusedFromResume = true;
              }
            } catch { /* missing or invalid — fall through to Claude ranking */ }
          }
          if (reusedFromResume) {
            // describeMap is set; skip the full ranking + post-process block below.
          } else {
          emit(jobId, {
            step: "images",
            status: "running",
            progress: 8,
            message: `Ranking refs (Claude) sur kit '${legacySlug}'...`,
          });
          // Ask for top-10 candidates per scene to leave room for the post-process to find non-duplicate refs.
          const candidateMap = await buildDescribeKitMapping(
            legacySlug,
            imageScenes.map((s) => ({ index: s.index, imagePrompt: s.imagePrompt })),
            10,
          );
          if (candidateMap) {
            // Post-process with HARD anti-repetition:
            //   1. Never reuse the same ref on two consecutive scenes.
            //   2. HARD CAP: no ref used more than MAX_REUSE times across the whole sequence.
            //   3. Among allowed candidates, prefer the one with the lowest global usage.
            // Plus: prepend the pure stickman canonical (frame-005) to every scene that contains a stickman
            // so WAN sees the character style explicitly, even when the kit ref has its own character.
            const finalMap = new Map<number, string[]>();
            const usageCount = new Map<string, number>(); // path -> times picked
            let prevPick: string | null = null;
            // MAX_REUSE: computed dynamically so the cap allows enough refs to cover the script.
            // ceil(scenes / available_refs) + 1 gives a safe floor.
            const allRefPaths = new Set<string>();
            for (const cs of candidateMap.values()) cs.forEach((p) => allRefPaths.add(p));
            const MAX_REUSE = Math.max(2, Math.ceil(imageScenes.length / Math.max(1, allRefPaths.size)) + 1);
            console.log(`[Pipeline] anti-duplicate cap: max ${MAX_REUSE}× réutilisation par ref (${allRefPaths.size} refs disponibles, ${imageScenes.length} scènes)`);

            // Canonical: pure stickman ref (frame-005) — better than frame-003 because it has no scenery.
            const canonicalStickPath = path.join(process.cwd(), "public", "style-refs", legacySlug, "style", "frame-005.png");
            let canonicalStickExists = false;
            try { await stat(canonicalStickPath); canonicalStickExists = true; } catch { /* not present */ }
            if (canonicalStickExists) console.log(`[Pipeline] canonical pure-stick ref: ${canonicalStickPath}`);
            else console.warn(`[Pipeline] canonical pure-stick ref absent (${canonicalStickPath})`);

            for (const s of imageScenes) {
              const candidates = candidateMap.get(s.index) ?? [];
              if (candidates.length === 0) {
                // No candidate from Claude ranking — fall back to canonical alone (for stick scenes).
                const wantsStick = /stickman|stick figure/i.test(s.imagePrompt);
                finalMap.set(s.index, wantsStick && canonicalStickExists ? [canonicalStickPath] : []);
                continue;
              }
              // Filter: not prev, not over-capped.
              const allowed = candidates.filter((c) => c !== prevPick && (usageCount.get(c) ?? 0) < MAX_REUSE);
              // Fallback chain: if cap eliminates everything, allow over-cap but keep no-prev. If still empty, take prev too.
              const pool = allowed.length > 0
                ? allowed
                : candidates.filter((c) => c !== prevPick).length > 0
                  ? candidates.filter((c) => c !== prevPick)
                  : candidates;
              // Within the pool, pick the one with lowest current usage (best spread).
              let best = pool[0];
              let bestUsage = usageCount.get(best) ?? 0;
              for (let i = 1; i < pool.length; i++) {
                const u = usageCount.get(pool[i]) ?? 0;
                if (u < bestUsage) { best = pool[i]; bestUsage = u; }
              }
              // Build ref list. Prepend canonical pure-stick if the scene has a stickman AND the picked ref isn't already canonical.
              const wantsStick = /stickman|stick figure/i.test(s.imagePrompt);
              const refList = (canonicalStickExists && wantsStick && best !== canonicalStickPath)
                ? [canonicalStickPath, best]
                : [best];
              finalMap.set(s.index, refList);
              usageCount.set(best, (usageCount.get(best) ?? 0) + 1);
              prevPick = best;
            }
            describeMap = finalMap;

            const hits = Array.from(describeMap.values()).filter((p) => p.length > 0).length;
            const uniqueRefs = new Set([...usageCount.keys()]).size;
            const maxUsage = Math.max(0, ...Array.from(usageCount.values()));
            console.log(`[Pipeline] describe-mode kit: ${hits}/${imageScenes.length} scènes — ${uniqueRefs} refs uniques (max réutilisation: ${maxUsage}×)`);

            // Persist the scene→refs mapping (final pick + all candidates) so the user can audit.
            const publicPrefix = path.join(process.cwd(), "public") + path.sep;
            const toPublicUrl = (absPath: string) =>
              absPath.startsWith(publicPrefix) ? "/" + absPath.slice(publicPrefix.length).split(path.sep).join("/") : absPath;
            const mappingRows = imageScenes.map((s) => {
              const picked = describeMap!.get(s.index) ?? [];
              const candidates = candidateMap.get(s.index) ?? [];
              return {
                sceneIndex: s.index,
                narration: s.narration,
                imagePrompt: s.imagePrompt,
                refs: picked.map((p) => ({ filename: path.basename(p), url: toPublicUrl(p) })),
                candidates: candidates.map((p) => ({ filename: path.basename(p), url: toPublicUrl(p) })),
              };
            });
            try {
              await writeFile(
                path.join(jobDir, "refs-mapping.json"),
                JSON.stringify({ kit: legacySlug, topN: 5, antiDuplicate: true, scenes: mappingRows }, null, 2),
              );
              console.log(`[Pipeline] refs-mapping.json écrit (${mappingRows.length} scènes)`);
            } catch (err) {
              console.warn(`[Pipeline] refs-mapping.json write failed (non-blocking):`, (err as Error).message);
            }
          }
          } // end of else (reusedFromResume)
        }
      } catch (err) {
        console.warn(`[Pipeline] describe-mode mapping failed (non-blocking), fallback dual/legacy:`, (err as Error).message);
        describeMap = null;
      }
    }

    // Resolver priority: dual-kit > describe-map > legacy bucket routing.
    const kitResolver = dualMode
      ? async (_idx: number, imagePrompt: string) =>
          resolveSplitRefsForScene(humanSlug || legacySlug, objectSlug || legacySlug, imagePrompt)
      : describeMap
      ? async (idx: number, _imagePrompt: string) => describeMap!.get(idx) ?? []
      : legacySlug
      ? async (_idx: number, imagePrompt: string) => resolveKitRefs(legacySlug, imagePrompt)
      : undefined;
    // Stream image previews to the UI as each scene completes. The runner is the only
    // place that knows the public URL prefix; we persist incrementally into job.result so
    // a /pipeline-status reconnect mid-run can resume the grid.
    const streamedScenes = new Set<number>();
    job.result.images = job.result.images ?? [...reusedImages];
    for (const r of reusedImages) {
      const url = imageUrlFor(jobId, r.imagePath);
      emit(jobId, {
        step: "images",
        status: "running",
        progress: 0,
        message: `scene ${r.sceneIndex} (reused)`,
        data: { sceneIndex: r.sceneIndex, url, status: "ready" },
      });
      streamedScenes.add(r.sceneIndex);
    }

    // When the describe-kit semantic resolver is active, prefix every prompt with an explicit
    // instruction telling the image model to lean on the references for style. Without this,
    // the model treats refs as loose guides; with it, output sticks to the kit's DA.
    const refPrefix = describeMap
      ? "Use the image reference. Match the style of the reference image as closely as possible. "
      : "";

    const provider = params.imageProvider ?? "genaipro";
    // Cast to a common signature: each provider has a slightly different `model` literal type,
    // but the caller selects the right model string for the active provider, so we widen at the
    // type level only.
    type ImagesFn = (
      scenes: { index: number; imagePrompt: string }[],
      outDir: string,
      onProgress: (done: number, total: number) => void,
      opts?: Record<string, unknown>,
    ) => Promise<ImageResult[]>;
    const generateImagesFn: ImagesFn =
      (provider === "geminigen" ? generateImagesGeminigen
      : provider === "wan" ? generateImagesWan
      : provider === "flowmax" ? generateImagesFlowmax
      : generateImagesGenAIPro) as unknown as ImagesFn;
    const providerLabel =
      provider === "geminigen" ? `Geminigen/${params.geminigenModel ?? "nano-banana-2"}`
      : provider === "wan" ? `WAN/${params.wanModel ?? "wan2.7-image"}`
      : provider === "flowmax" ? "FlowMax (Google Flow)"
      : "GenAIPro Veo";
    console.log(`[Pipeline] image provider = ${providerLabel}`);

    const images = imageScenes.length > 0
      ? await generateImagesFn(
          imageScenes.map((s) => ({
            index: s.index,
            imagePrompt: `${refPrefix}${styleHint ? `${s.imagePrompt}, ${styleHint}` : s.imagePrompt}`,
          })),
          imagesDir,
          (done, total) => {
            const pct = Math.round((done / total) * 100);
            emit(jobId, { step: "images", status: "running", progress: pct, message: `${done}/${total} (${providerLabel})` });
          },
          {
            premiumScenes,
            referenceImagePaths: !kitResolver && userRefs.length ? userRefs : undefined,
            resolveRefsForScene: kitResolver,
            ...(provider === "geminigen" ? { model: params.geminigenModel ?? "nano-banana-2" } : {}),
            ...(provider === "wan" ? { model: params.wanModel ?? "wan2.7-image" } : {}),
            onImageReady: (result: ImageResult) => {
              if (streamedScenes.has(result.sceneIndex)) return;
              streamedScenes.add(result.sceneIndex);
              job.result.images = [...(job.result.images ?? []), result].sort((a, b) => a.sceneIndex - b.sceneIndex);
              emit(jobId, {
                step: "images",
                status: "running",
                progress: Math.round((streamedScenes.size / Math.max(1, script.scenes.length)) * 100),
                message: `scene ${result.sceneIndex} ready`,
                data: { sceneIndex: result.sceneIndex, url: imageUrlFor(jobId, result.imagePath), status: "ready" },
              });
            },
            onImageFailed: (sceneIndex: number, error: string) => {
              emit(jobId, {
                step: "images",
                status: "running",
                progress: 0,
                message: `scene ${sceneIndex} failed: ${error.slice(0, 80)}`,
                data: { sceneIndex, status: "failed", error: error.slice(0, 200) },
              });
            },
          },
        )
      : [];
    job.result.images = [...reusedImages, ...images].sort((a, b) => a.sceneIndex - b.sceneIndex);

    // --- Contrôle qualité (vision) + regen auto des images "bad" (1 passe) ---
    // Toujours actif (hors pilote, qui est lui-même une QA visuelle manuelle).
    if (!isPilot && job.result.images.length > 0) {
      emit(jobId, { step: "images", status: "running", progress: 100, message: "Contrôle qualité (vision)..." });
      const bad: ImageResult[] = [];
      const CONC = 3;
      const list = job.result.images;
      for (let i = 0; i < list.length; i += CONC) {
        const verdicts = await Promise.all(
          list.slice(i, i + CONC).map(async (img) => {
            try { return { img, sev: (await findImageIssues(img.imagePath)).severity }; }
            catch { return { img, sev: "ok" as const }; }
          }),
        );
        for (const v of verdicts) if (v.sev === "bad") bad.push(v.img);
      }
      if (bad.length > 0) {
        emit(jobId, { step: "images", status: "running", progress: 100, message: `${bad.length} image(s) ratée(s) → regen...` });
        const regenScenes = bad.map((img) => {
          const sc = script.scenes.find((s) => s.index === img.sceneIndex);
          const base = sc ? sc.imagePrompt : img.prompt;
          return { index: img.sceneIndex, imagePrompt: `${refPrefix}${styleHint ? `${base}, ${styleHint}` : base}` };
        });
        try {
          const regenerated = await generateImagesFn(regenScenes, imagesDir, () => {}, {
            premiumScenes,
            referenceImagePaths: !kitResolver && userRefs.length ? userRefs : undefined,
            resolveRefsForScene: kitResolver,
            ...(provider === "geminigen" ? { model: params.geminigenModel ?? "nano-banana-2" } : {}),
            ...(provider === "wan" ? { model: params.wanModel ?? "wan2.7-image" } : {}),
          });
          const byIdx = new Map(job.result.images.map((im) => [im.sceneIndex, im]));
          for (const r of regenerated) byIdx.set(r.sceneIndex, r);
          job.result.images = [...byIdx.values()].sort((a, b) => a.sceneIndex - b.sceneIndex);
          emit(jobId, { step: "images", status: "running", progress: 100, message: `${regenerated.length} image(s) régénérée(s) (QC vision)` });
        } catch (err) {
          console.warn("[Pipeline] regen QC vision échoué:", (err as Error).message);
        }
      } else {
        emit(jobId, { step: "images", status: "running", progress: 100, message: "QC vision : aucune image ratée" });
      }
    }

    // --- Comble les images MANQUANTES avant le montage (gap-fill) ---
    // FlowMax (et les autres providers) peut timeouter sur quelques scènes → 0
    // fichier sur le disque. Le QC vision ci-dessus ne voit que les images
    // existantes ; ici on regarde le DISQUE, on régénère toute scène sans fichier
    // (2 passes — un re-submit frais retombe souvent sur un worker dispo). Sinon
    // le montage substitue l'image précédente → trou visuel / désync.
    if (!isPilot && imageScenes.length > 0) {
      const presentIndices = async (): Promise<Set<number>> => {
        const s = new Set<number>();
        try {
          for (const f of await readdir(imagesDir)) {
            const m = /^scene_(\d+)\.(png|jpe?g|webp)$/i.exec(f);
            if (m) s.add(Number(m[1]));
          }
        } catch { /* dir missing */ }
        return s;
      };
      for (let pass = 1; pass <= 2; pass++) {
        const present = await presentIndices();
        const missing = imageScenes.filter((s) => !present.has(s.index));
        if (missing.length === 0) break;
        console.warn(`[Pipeline] ${missing.length} image(s) manquante(s) avant montage (passe ${pass}/2): ${missing.map((s) => s.index).slice(0, 20).join(",")}`);
        emit(jobId, { step: "images", status: "running", progress: 100, message: `${missing.length} image(s) manquante(s) → regen (passe ${pass}/2)...` });
        try {
          const filled = await generateImagesFn(
            missing.map((s) => ({ index: s.index, imagePrompt: `${refPrefix}${styleHint ? `${s.imagePrompt}, ${styleHint}` : s.imagePrompt}` })),
            imagesDir,
            () => {},
            {
              premiumScenes,
              referenceImagePaths: !kitResolver && userRefs.length ? userRefs : undefined,
              resolveRefsForScene: kitResolver,
              ...(provider === "geminigen" ? { model: params.geminigenModel ?? "nano-banana-2" } : {}),
              ...(provider === "wan" ? { model: params.wanModel ?? "wan2.7-image" } : {}),
            },
          );
          const merged = new Map<number, ImageResult>();
          for (const im of job.result.images ?? []) merged.set(im.sceneIndex, im);
          for (const r of filled) merged.set(r.sceneIndex, r);
          job.result.images = Array.from(merged.values()).sort((a, b) => a.sceneIndex - b.sceneIndex);
        } catch (err) {
          console.warn(`[Pipeline] gap-fill images manquantes échoué (passe ${pass}):`, (err as Error).message);
        }
      }
      const finalPresent = await presentIndices();
      const stillMissing = imageScenes.filter((s) => !finalPresent.has(s.index));
      if (stillMissing.length > 0) {
        console.warn(`[Pipeline] ${stillMissing.length} image(s) toujours manquante(s) après gap-fill — le montage substituera: ${stillMissing.map((s) => s.index).slice(0, 20).join(",")}`);
      }
    }

    const reusedNote = reusedImages.length > 0 ? ` (+${reusedImages.length} réutilisées)` : "";
    const pilotNote = isPilot ? ` · pilot` : "";
    emit(jobId, { step: "images", status: "completed", progress: 100,
      message: `${job.result.images.length} images${reusedNote}${pilotNote}` });
  }

  // --- Step 4: Images premium (GenAIPro Veo, scènes clés) — standalone re-gen if enabled without images step ---
  if (isEnabled(params, "premium") && !isEnabled(params, "images")) {
    emit(jobId, { step: "premium", status: "running", progress: 10, message: "Regeneration scenes cles GenAIPro Veo..." });
    const images = await generateImagesGenAIPro(
      script.scenes.map((s) => ({ index: s.index, imagePrompt: s.imagePrompt })),
      imagesDir,
      (done, total) => {
        const pct = Math.round((done / total) * 100);
        emit(jobId, { step: "premium", status: "running", progress: pct, message: `${done}/${total} scenes premium` });
      },
      { premiumScenes: script.scenes.map((s) => s.index) },
    );
    job.result.images = images;
    emit(jobId, { step: "premium", status: "completed", progress: 100, message: `${images.length} images premium` });
  } else if (isEnabled(params, "premium") && isEnabled(params, "images")) {
    emit(jobId, { step: "premium", status: "completed", progress: 100, message: `Scenes cles traitees (GenAIPro Veo)` });
  }

  // --- Step 5: Images bulk (GenAIPro Veo, B-roll) ---
  if (isEnabled(params, "bulk") && job.result.images) {
    emit(jobId, { step: "bulk", status: "running", progress: 5, message: "B-roll GenAIPro Veo..." });
    const bulkDir = path.join(jobDir, "images_bulk");
    await mkdir(bulkDir, { recursive: true });

    // Generate additional B-roll images (same scenes with alternate prompts)
    const bulkImages = await generateImagesGenAIPro(
      script.scenes.map((s) => ({
        index: s.index,
        imagePrompt: `${s.imagePrompt}, alternative perspective, b-roll shot`,
      })),
      bulkDir,
      (done, total) => {
        const pct = Math.round((done / total) * 100);
        emit(jobId, { step: "bulk", status: "running", progress: pct, message: `${done}/${total} b-roll` });
      },
      { useBulk: true },
    );
    job.result.brollImages = bulkImages;
    emit(jobId, { step: "bulk", status: "completed", progress: 100, message: `${bulkImages.length} images b-roll` });
  }

  // --- Step 5.5: Archives (Wikimedia Commons + Pexels) ---
  if (isEnabled(params, "archives")) {
    try {
      emit(jobId, { step: "archives", status: "running", progress: 5, message: "Recherche archives..." });
      const archivesDir = path.join(jobDir, "archives");
      await mkdir(archivesDir, { recursive: true });

      const config = await getConfig();
      const archiveDensity = preset.visual.archiveDensity || "sparse";
      const archives = await fetchArchivesForScenes(
        script.scenes,
        archivesDir,
        config.pexelsKey,
        archiveDensity,
        (done, total) => {
          const pct = Math.round((done / total) * 100);
          emit(jobId, { step: "archives", status: "running", progress: pct,
            message: `${done}/${total} archives` });
        },
      );
      job.result.archives = archives;
      const imgs = archives.items.filter((a) => a.type === "image").length;
      const vids = archives.items.filter((a) => a.type === "video").length;
      emit(jobId, { step: "archives", status: "completed", progress: 100,
        message: `${archives.items.length} archives (${imgs} images, ${vids} videos)` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Pipeline] Archives echouees, on continue sans:`, errMsg);
      emit(jobId, { step: "archives", status: "failed", progress: 0,
        message: `Echec: ${errMsg.slice(0, 80)}` });
    }
  }

  // --- Step 6: Animation ---
  const videoMode = params.videoMode ?? "t2v";
  const animationProvider = params.animationProvider ?? "genaipro";
  const animationGate = videoMode === "t2v" ? true : !!job.result.images;
  if ((animationProvider === "wan" || animationProvider === "seedance") && (videoMode === "t2v" || videoMode === "ingredients")) {
    console.warn(`[Pipeline] animationProvider=${animationProvider} ignoré pour videoMode=${videoMode} (i2v only) → fallback Veo3.`);
  }
  if (isEnabled(params, "animation") && animationGate) {
    const clipsDir = path.join(jobDir, "clips");
    await mkdir(clipsDir, { recursive: true });

    try {
      // ============ MODE: text-to-video ============
      if (videoMode === "t2v") {
        const target = animationScenes;
        const totalDisplay = target.length + reusedClips.length;
        emit(jobId, { step: "animation", status: "running", progress: 5,
          message: `Veo3 T2V — ${target.length} clips${isPilot ? " (pilot)" : ""}${reusedClips.length ? ` (+${reusedClips.length} réutilisés)` : ""}...` });
        const clips: AnimationResult[] = [];
        const T2V_CONCURRENCY = 4;
        for (let i = 0; i < target.length; i += T2V_CONCURRENCY) {
          const batch = target.slice(i, i + T2V_CONCURRENCY);
          const results = await Promise.all(batch.map((scene) => {
            const clipPath = path.join(clipsDir, `clip_${String(scene.index).padStart(3, "0")}.mp4`);
            // Extract mode: user's prompts already carry the style → don't append.
            const skipT2VStyle = params.customScriptHasImagePrompts === true;
            const styleSuffix = skipT2VStyle
              ? ""
              : ((params.customStyle && params.customStyle.trim()) || preset.visual.imageStyleSuffix);
            const prompt = scene.imagePrompt + (styleSuffix ? `, ${styleSuffix}` : "");
            return generateT2VClip(prompt, scene.index, clipPath);
          }));
          clips.push(...results);
          const pct = target.length === 0 ? 100 : Math.round((clips.length / target.length) * 95) + 5;
          emit(jobId, { step: "animation", status: "running", progress: pct,
            message: `${clips.length}/${target.length} clips T2V` });
        }
        job.result.animation = [...reusedClips, ...clips].sort((a, b) => a.sceneIndex - b.sceneIndex);
        emit(jobId, { step: "animation", status: "completed", progress: 100,
          message: `${job.result.animation.length} clips Veo3 T2V${totalDisplay !== job.result.animation.length ? "" : ""}` });

      // ============ MODE: ingredients-to-video ============
      } else if (videoMode === "ingredients") {
        const clips: AnimationResult[] = [];
        const ING_CONCURRENCY = 4;
        // Group reference images: scene's main image + bulk B-roll images for context.
        const bulkByIdx = new Map<number, string[]>();
        for (const img of (job.result.brollImages ?? [])) {
          if (!bulkByIdx.has(img.sceneIndex)) bulkByIdx.set(img.sceneIndex, []);
          bulkByIdx.get(img.sceneIndex)!.push(img.imagePath);
        }
        const userRefs = params.userRefImagePaths ?? [];
        const tasks = animationScenes.map((scene) => {
          const main = job.result.images!.find((i) => i.sceneIndex === scene.index);
          const refs = [
            ...userRefs,
            main?.imagePath,
            ...(bulkByIdx.get(scene.index) ?? []),
          ].filter(Boolean) as string[];
          return { scene, refs };
        }).filter((t) => t.refs.length > 0);

        emit(jobId, { step: "animation", status: "running", progress: 5,
          message: `Veo3 Ingredients — ${tasks.length} clips${isPilot ? " (pilot)" : ""}${reusedClips.length ? ` (+${reusedClips.length} réutilisés)` : ""}...` });

        for (let i = 0; i < tasks.length; i += ING_CONCURRENCY) {
          const batch = tasks.slice(i, i + ING_CONCURRENCY);
          const results = await Promise.all(batch.map(({ scene, refs }) => {
            const clipPath = path.join(clipsDir, `clip_${String(scene.index).padStart(3, "0")}.mp4`);
            const motion = scene.motionPrompt || "Slow cinematic camera movement, smooth pan";
            return generateIngredientsClip(motion, refs, scene.index, clipPath);
          }));
          clips.push(...results);
          const pct = tasks.length === 0 ? 100 : Math.round((clips.length / tasks.length) * 95) + 5;
          emit(jobId, { step: "animation", status: "running", progress: pct,
            message: `${clips.length}/${tasks.length} clips Ingredients` });
        }
        job.result.animation = [...reusedClips, ...clips].sort((a, b) => a.sceneIndex - b.sceneIndex);
        emit(jobId, { step: "animation", status: "completed", progress: 100,
          message: `${job.result.animation.length} clips Veo Ingredients` });

      } else {
        // ============ MODE: image-to-video (default) ============
        const doneClipSet = new Set(reusedClips.map((c) => c.sceneIndex));
        const i2vTargets = job.result.images!.filter((img) => {
          if (pilotSet && !pilotSet.has(img.sceneIndex)) return false;
          if (doneClipSet.has(img.sceneIndex)) return false;
          return true;
        });
        const i2vLabel =
          animationProvider === "wan" ? `WAN/${params.wanI2VModel ?? "wan2.2-i2v-flash"}`
          : animationProvider === "seedance" ? "Seedance"
          : "Veo3";
        emit(jobId, { step: "animation", status: "running", progress: 5,
          message: `${i2vLabel} I2V — ${i2vTargets.length} clips${isPilot ? " (pilot)" : ""}${reusedClips.length ? ` (+${reusedClips.length} réutilisés)` : ""}...` });
        const onI2VProgress = (done: number, total: number) => {
          const pct = Math.round((done / total) * 100);
          emit(jobId, { step: "animation", status: "running", progress: pct, message: `${done}/${total} clips ${i2vLabel}` });
        };
        const i2vInput = i2vTargets.map((img) => ({
          imagePath: img.imagePath,
          sceneIndex: img.sceneIndex,
          motionPrompt: script.scenes[img.sceneIndex]?.motionPrompt,
        }));
        const animations = i2vTargets.length === 0
          ? []
          : animationProvider === "wan"
            ? await animateImagesWan(i2vInput, clipsDir, script.scenes, onI2VProgress, { model: params.wanI2VModel ?? "wan2.2-i2v-flash" })
            : animationProvider === "seedance"
              ? await animateImagesSeedance(i2vInput, clipsDir, script.scenes, onI2VProgress)
              : await animateImagesGenAIPro(i2vInput, clipsDir, script.scenes, onI2VProgress);
        job.result.animation = [...reusedClips, ...animations].sort((a, b) => a.sceneIndex - b.sceneIndex);
        emit(jobId, { step: "animation", status: "completed", progress: 100,
          message: `${job.result.animation.length} clips (${i2vLabel})` });
      }

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Pipeline] Animation echouee, on continue sans clips:`, errMsg);
      emit(jobId, { step: "animation", status: "failed", progress: 0,
        message: `Echec: ${errMsg.slice(0, 80)} — fallback Ken Burns` });
    }
  }

  // --- Step 7: Background music ---
  if (isEnabled(params, "music")) {
    emit(jobId, { step: "music", status: "running", progress: 20, message: "Generation musique ambient..." });
    const musicPath = path.join(jobDir, "music.wav");
    const totalDuration = script.scenes.reduce((s, sc) => s + sc.durationSeconds, 0);
    const music = await generateMusic(params.title, params.niche, totalDuration, musicPath);
    job.result.music = music;
    emit(jobId, { step: "music", status: "completed", progress: 100, message: `Musique ${music.genre || "ambient"} generee` });
  }

  // (Le step "thumbnails" tourne en parallèle depuis juste après le script — voir thumbnailPromise.)

  // --- PILOT short-circuit: pas de montage, on s'arrête après l'animation pour QA visuelle ---
  if (isPilot) {
    if (thumbnailPromise) await thumbnailPromise;
    job.status = "completed";
    job.currentStep = null;
    const isStaticPilot = (params.videoMode ?? "t2v") === "static-images";
    const count = isStaticPilot
      ? (job.result.images?.length ?? 0)
      : (job.result.animation?.length ?? 0);
    const noun = isStaticPilot ? "images" : "clips";
    console.log(`[Pipeline] PILOT ${jobId} terminé — ${count} ${noun} à valider`);
    await markChannelFlowPilotDone(job);
    return;
  }

  // Récupère la voix off lancée en parallèle des images (TTS GenAI ~40min).
  // Le montage a besoin de l'audio + des durations alignées Whisper → on attend ici.
  await voiceoverPromise;
  if (voiceoverError) throw voiceoverError;

  // --- Step 9: Montage FFmpeg (Ken Burns + audio) ---
  const voiceoverPath = job.result.voiceover?.audioPath;
  const voiceoverEnabled = params.voiceoverEnabled !== false && isEnabled(params, "voiceover");
  if (voiceoverEnabled && !voiceoverPath) {
    throw new Error("Voiceover manquant pour le montage");
  }
  // muteClipAudio=true → strip clip audio (current behaviour). Default = strip.
  // When false (toggle ON in UI), assembleMontage keeps the original Veo3 audio.
  const keepClipAudio = params.muteClipAudio === false;

  const videoPath = path.join(jobDir, "output.mp4");

  const hasClips = job.result.animation?.some((a) => !a.isMock);
  const hasBroll = (job.result.brollImages?.length || 0) > 0;
  const montageType = hasClips ? "Clips + Ken Burns" : hasBroll ? "Ken Burns + B-roll" : "Ken Burns";
  emit(jobId, { step: "montage", status: "running", progress: 5, message: `Assemblage ${montageType}...` });

  const montage = await assembleMontage(
    {
      audioPath: voiceoverEnabled ? voiceoverPath : undefined,
      musicPath: job.result.music?.audioPath,
      images: job.result.images || [],
      brollImages: preset.visual.brollEnabled ? job.result.brollImages : undefined,
      clips: job.result.animation,
      archives: job.result.archives?.items,
      scenes: script.scenes,
      outputPath: videoPath,
      kenBurns: true,
      kenBurnsSpeed: preset.visual.kenBurnsSpeed,
      transitionType: preset.visual.transitionType,
      transitionDuration: preset.visual.transitionDuration,
      musicVolume: preset.audio.musicVolume,
      subtitlesEnabled: isEnabled(params, "subtitles"),
      keepClipAudio,
    },
    (percent) => {
      emit(jobId, { step: "montage", status: "running", progress: percent, message: `Encodage ${percent}%` });
    },
  );
  job.result.montage = montage;
  emit(jobId, { step: "montage", status: "completed", progress: 100, message: `Video ${Math.round(montage.durationSeconds)}s (${(montage.fileSize / 1024 / 1024).toFixed(1)} Mo)` });

  // Attend que la thumbnail parallèle se termine (succès ou fail non bloquant)
  // avant de marquer le job completed, pour que le SSE listener ne ferme pas
  // avant le dernier event "thumbnails".
  if (thumbnailPromise) await thumbnailPromise;

  job.status = "completed";
  job.currentStep = null;
  console.log(`[Pipeline] Job ${jobId} termine avec succes`);

  // Synchro retour ChannelFlow (no-op si le job n'a pas de channelflowVideoId).
  await syncJobToChannelFlow(job);
}
