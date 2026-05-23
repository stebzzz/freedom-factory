import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { startPipeline, getJob, getAllJobs } from "@/lib/pipeline/runner";
import { PipelineJobParams } from "@/lib/pipeline/types";

const ALLOWED_REF_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const MAX_REF_BYTES = 15 * 1024 * 1024;
const MAX_REF_COUNT = 8;

async function saveUploadedRefs(files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_REF_COUNT) {
    throw new Error(`Trop d'images de référence (${files.length} > ${MAX_REF_COUNT})`);
  }
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(process.cwd(), "public", "uploads", `ref_${stamp}`);
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size === 0) continue;
    if (f.size > MAX_REF_BYTES) throw new Error(`Image trop lourde: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} Mo)`);
    if (!ALLOWED_REF_MIME.has(f.type)) throw new Error(`Format non supporté: ${f.name} (${f.type || "inconnu"})`);
    const ext = f.type === "image/webp" ? "webp" : f.type === "image/png" ? "png" : "jpg";
    const safeName = `ref_${String(i).padStart(2, "0")}.${ext}`;
    const dest = path.join(dir, safeName);
    const buf = Buffer.from(await f.arrayBuffer());
    await writeFile(dest, buf);
    paths.push(dest);
  }
  return paths;
}

function pickString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let params: PipelineJobParams;

    if (contentType.includes("multipart/form-data")) {
      const fd = await request.formData();
      const files = fd.getAll("userRefImages").filter((v): v is File => v instanceof File);
      const userRefImagePaths = await saveUploadedRefs(files);
      const duration = Number(fd.get("duration"));
      const voiceoverEnabledRaw = pickString(fd.get("voiceoverEnabled"));
      const muteClipAudioRaw = pickString(fd.get("muteClipAudio"));
      params = {
        title: pickString(fd.get("title")) ?? "",
        niche: pickString(fd.get("niche")) ?? "",
        description: pickString(fd.get("description")) ?? "",
        voix: pickString(fd.get("voix")) ?? "male-fr",
        duration: Number.isFinite(duration) && duration > 0 ? duration : 10,
        scenario: (pickString(fd.get("scenario")) as "A" | "B") || "A",
        presetId: pickString(fd.get("presetId")),
        customScript: pickString(fd.get("customScript")),
        customStyle: pickString(fd.get("customStyle")),
        videoMode: (pickString(fd.get("videoMode")) as PipelineJobParams["videoMode"]) || "t2v",
        userRefImagePaths: userRefImagePaths.length ? userRefImagePaths : undefined,
        styleKitSlug: pickString(fd.get("styleKitSlug")),
        voiceoverEnabled: voiceoverEnabledRaw === undefined ? undefined : voiceoverEnabledRaw !== "false",
        muteClipAudio: muteClipAudioRaw === undefined ? undefined : muteClipAudioRaw !== "false",
        pilotMode: pickString(fd.get("pilotMode")) === "true" || undefined,
        customScriptHasImagePrompts: pickString(fd.get("customScriptHasImagePrompts")) === "true" || undefined,
        subtitlesEnabled: (() => {
          const v = pickString(fd.get("subtitlesEnabled"));
          if (v === undefined) return undefined;
          return v === "true";
        })(),
        alignWithWhisper: (() => {
          const v = pickString(fd.get("alignWithWhisper"));
          if (v === undefined) return undefined;
          return v !== "false";
        })(),
        competitorVideoUrl: pickString(fd.get("competitorVideoUrl")),
        rewriteCompetitorScript: pickString(fd.get("rewriteCompetitorScript")) === "true" || undefined,
        describeKitScriptSource: (() => {
          const v = pickString(fd.get("describeKitScriptSource"));
          return v === "auto" || v === "custom" ? v : undefined;
        })(),
        imageProvider: (() => {
          const v = pickString(fd.get("imageProvider"));
          return v === "geminigen" || v === "genaipro" || v === "wan" ? v : undefined;
        })(),
        geminigenModel: (() => {
          const v = pickString(fd.get("geminigenModel"));
          return v === "nano-banana-pro" || v === "nano-banana-2" || v === "imagen-4" ? v : undefined;
        })(),
        wanModel: (() => {
          const v = pickString(fd.get("wanModel"));
          return v === "wan2.7-image" || v === "wan2.7-image-pro" ? v : undefined;
        })(),
        animationProvider: (() => {
          const v = pickString(fd.get("animationProvider"));
          return v === "genaipro" || v === "wan" ? v : undefined;
        })(),
        wanI2VModel: (() => {
          const v = pickString(fd.get("wanI2VModel"));
          return v === "wan2.2-i2v-flash" || v === "wan2.2-i2v-plus" || v === "wanx2.1-i2v-turbo" || v === "wanx2.1-i2v-plus" ? v : undefined;
        })(),
        voiceModel: (() => {
          const v = pickString(fd.get("voiceModel"));
          return v === "genaipro" || v === "elevenlabs" || v === "fishspeech" ? v : undefined;
        })(),
        genaiproTTSModel: (() => {
          const v = pickString(fd.get("genaiproTTSModel"));
          return v === "eleven_multilingual_v2" || v === "eleven_turbo_v2_5" || v === "eleven_flash_v2_5" || v === "eleven_v3" ? v : undefined;
        })(),
        voiceSpeed: (() => {
          const v = pickString(fd.get("voiceSpeed"));
          const n = v ? parseFloat(v) : NaN;
          return Number.isFinite(n) ? Math.max(0.7, Math.min(1.2, n)) : undefined;
        })(),
        audioSpeed: (() => {
          const v = pickString(fd.get("audioSpeed"));
          const n = v ? parseFloat(v) : NaN;
          return Number.isFinite(n) ? Math.max(0.5, Math.min(2.0, n)) : undefined;
        })(),
        voiceoverGate: pickString(fd.get("voiceoverGate")) === "true" || pickString(fd.get("voiceoverGate")) === "on",
        scriptOnly: pickString(fd.get("scriptOnly")) === "true" || pickString(fd.get("scriptOnly")) === "on",
      };
    } else {
      const body = await request.json() as PipelineJobParams;
      params = {
        title: body.title,
        niche: body.niche,
        description: body.description || "",
        voix: body.voix || "male-fr",
        duration: body.duration || 10,
        scenario: body.scenario || "A",
        enabledSteps: body.enabledSteps || {},
        presetId: body.presetId,
        customScript: body.customScript,
        customStyle: body.customStyle,
        parsedScenes: body.parsedScenes,
        videoMode: body.videoMode,
        voiceoverEnabled: body.voiceoverEnabled,
        muteClipAudio: body.muteClipAudio,
        pilotMode: body.pilotMode,
        pilotSampleSize: body.pilotSampleSize,
        resumeFromPilotId: body.resumeFromPilotId,
        userRefImagePaths: body.userRefImagePaths,
        styleKitSlug: body.styleKitSlug,
        customScriptHasImagePrompts: body.customScriptHasImagePrompts,
        subtitlesEnabled: body.subtitlesEnabled,
        alignWithWhisper: body.alignWithWhisper,
        competitorVideoUrl: body.competitorVideoUrl,
        rewriteCompetitorScript: body.rewriteCompetitorScript,
        describeKitScriptSource: body.describeKitScriptSource,
        imageProvider: body.imageProvider,
        geminigenModel: body.geminigenModel,
        wanModel: body.wanModel,
        animationProvider: body.animationProvider,
        wanI2VModel: body.wanI2VModel,
        voiceModel: body.voiceModel,
        genaiproTTSModel: body.genaiproTTSModel,
        voiceSpeed: body.voiceSpeed,
        audioSpeed: body.audioSpeed,
        voiceoverGate: body.voiceoverGate,
        scriptOnly: body.scriptOnly,
      };
    }

    if (!params.title || !params.niche) {
      return NextResponse.json({ error: "title et niche requis" }, { status: 400 });
    }

    const jobId = await startPipeline(params);
    return NextResponse.json({ jobId, message: "Pipeline lance" });
  } catch (err) {
    console.error("[API /pipeline]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");

  if (id) {
    const job = getJob(id);
    if (!job) return NextResponse.json({ error: "Job introuvable" }, { status: 404 });
    return NextResponse.json(job);
  }

  return NextResponse.json(getAllJobs());
}
