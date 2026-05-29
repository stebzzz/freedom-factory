import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  addToQueue,
  removeFromQueue,
  clearFinishedFromQueue,
  getQueueSnapshot,
  setWorkerEnabled,
  startQueueWorker,
  runQueueEntryNow,
  updateQueueEntryParams,
} from "@/lib/pipeline/queue";
import type { PipelineJobParams } from "@/lib/pipeline/types";

// Kick the worker singleton on first request after a server boot.
startQueueWorker().catch((e) => console.error("[API /queue] worker start failed", e));

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

async function parseParamsFromRequest(request: NextRequest): Promise<PipelineJobParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await request.formData();
    const files = fd.getAll("userRefImages").filter((v): v is File => v instanceof File);
    const userRefImagePaths = await saveUploadedRefs(files);
    const duration = Number(fd.get("duration"));
    const voiceoverEnabledRaw = pickString(fd.get("voiceoverEnabled"));
    const muteClipAudioRaw = pickString(fd.get("muteClipAudio"));
    return {
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
    };
  }
  const body = await request.json() as PipelineJobParams;
  return {
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
  };
}

export async function GET() {
  await startQueueWorker();
  return NextResponse.json(getQueueSnapshot());
}

export async function POST(request: NextRequest) {
  try {
    await startQueueWorker();
    const params = await parseParamsFromRequest(request);
    if (!params.title || !params.niche) {
      return NextResponse.json({ error: "title et niche requis" }, { status: 400 });
    }
    const entry = await addToQueue(params);
    return NextResponse.json({ entry, message: "Ajouté à la queue" });
  } catch (err) {
    console.error("[API /queue POST]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (id === "__finished__") {
    const removed = await clearFinishedFromQueue();
    return NextResponse.json({ removed });
  }
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
  const ok = await removeFromQueue(id);
  if (!ok) return NextResponse.json({ error: "Impossible de retirer (introuvable ou en cours)" }, { status: 400 });
  return NextResponse.json({ removed: 1 });
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      workerEnabled?: boolean;
      id?: string;
      params?: Partial<PipelineJobParams>;
      run?: boolean;
    };

    // Lancer une entrée : démarre tout de suite si rien ne tourne, sinon la
    // laisse en file (le worker l'enchaîne automatiquement) — jamais d'erreur "déjà en cours".
    if (body.id && body.run) {
      const r = await runQueueEntryNow(body.id);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ ...getQueueSnapshot(), queued: r.queued === true });
    }

    // Éditer les params d'une entrée en attente
    if (body.id && body.params) {
      const ok = await updateQueueEntryParams(body.id, body.params);
      if (!ok) {
        return NextResponse.json({ error: "Entrée introuvable ou déjà lancée." }, { status: 400 });
      }
      return NextResponse.json(getQueueSnapshot());
    }

    // Pause / reprise du worker
    if (typeof body.workerEnabled === "boolean") {
      await setWorkerEnabled(body.workerEnabled);
      return NextResponse.json(getQueueSnapshot());
    }

    return NextResponse.json({ error: "Requête PATCH non reconnue." }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
