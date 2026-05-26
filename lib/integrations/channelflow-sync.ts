// Synchro retour vers ChannelFlow (Firestore).
//
// Quand un job porte un `channelflowVideoId`, le runner appelle ces fonctions
// à la complétion / à l'échec pour mettre à jour la vidéo source dans la base
// Firestore de ChannelFlow (projet channelflow-5d14a) via le Firebase Admin SDK.
//
// - montage.mp4  → Cloudinary (/video/upload, preset non signé) → videoFileUrl
// - thumbnail    → Cloudinary (/image/upload) → thumbnailUrl
// - statut       → "to_schedule"
//
// (ChannelFlow stocke ses médias sur Cloudinary, pas Firebase Storage — on
//  reste cohérent. Firebase Admin ne sert qu'à écrire dans Firestore.)
//
// firebase-admin est importé statiquement mais initialisé paresseusement : sans
// service account configuré, getApp() renvoie null et les fonctions sont no-op.

import { readFile } from "fs/promises";
import { readFileSync } from "fs";
import admin from "firebase-admin";
import type { PipelineJob } from "@/lib/pipeline/types";

let app: admin.app.App | null = null;
let initFailed = false;

function loadServiceAccount(): admin.ServiceAccount | null {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (json && json.trim().startsWith("{")) {
    try {
      return JSON.parse(json) as admin.ServiceAccount;
    } catch (e) {
      console.error("[CF sync] FIREBASE_SERVICE_ACCOUNT (JSON inline) invalide:", e);
    }
  }
  const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p) {
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as admin.ServiceAccount;
    } catch (e) {
      console.error("[CF sync] lecture du service account échouée:", p, e);
    }
  }
  return null;
}

function getApp(): admin.app.App | null {
  if (app) return app;
  if (initFailed) return null;
  const sa = loadServiceAccount();
  if (!sa) {
    initFailed = true;
    console.warn("[CF sync] aucun service account (FIREBASE_SERVICE_ACCOUNT / _PATH) → write-back désactivé.");
    return null;
  }
  try {
    app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
    return app;
  } catch (e) {
    initFailed = true;
    console.error("[CF sync] initialisation Firebase Admin échouée:", e);
    return null;
  }
}

function safeBase(name: string): string {
  return (
    (name || "video")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "video"
  );
}

async function cloudinaryUpload(
  localPath: string,
  resourceType: "image" | "video",
  filename: string,
): Promise<{ secureUrl: string; publicId: string } | null> {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) {
    console.warn("[CF sync] Cloudinary non configuré (CLOUDINARY_CLOUD_NAME / _UPLOAD_PRESET).");
    return null;
  }
  try {
    const buf = await readFile(localPath);
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buf)]), filename);
    fd.append("upload_preset", preset);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/${resourceType}/upload`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[CF sync] Cloudinary ${resourceType} HTTP ${res.status} — ${t.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as { secure_url?: string; public_id?: string };
    if (!json.secure_url) return null;
    return { secureUrl: json.secure_url, publicId: json.public_id ?? "" };
  } catch (e) {
    console.warn(`[CF sync] upload ${resourceType} Cloudinary échoué:`, e);
    return null;
  }
}

// Appelée à la complétion d'un job. Best-effort : ne lève jamais (n'altère pas
// le statut du pipeline FF).
export async function syncJobToChannelFlow(job: PipelineJob): Promise<void> {
  const videoId = job.params.channelflowVideoId;
  if (!videoId) return;

  const application = getApp();
  if (!application) return;

  try {
    const update: Record<string, unknown> = {
      status: "to_schedule",
      ffStatus: "completed",
      ffJobId: job.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const montagePath = job.result.montage?.videoPath;
    if (montagePath) {
      const fileName = `${safeBase(job.params.title)}.mp4`;
      const up = await cloudinaryUpload(montagePath, "video", fileName);
      if (up) {
        update.videoFileUrl = up.secureUrl;
        update.videoFilePath = up.publicId;
        update.videoFileName = fileName;
      } else {
        console.warn(`[CF sync] montage non uploadé pour ${videoId} — vidéo mise à jour sans fichier.`);
      }
    }

    const thumbPath = job.result.thumbnails?.imagePath;
    if (thumbPath) {
      const tup = await cloudinaryUpload(thumbPath, "image", "thumbnail.png");
      if (tup) update.thumbnailUrl = tup.secureUrl;
    }

    await admin.firestore(application).collection("videos").doc(videoId).update(update);
    console.log(`[CF sync] vidéo ${videoId} → to_schedule (job ${job.id})`);
  } catch (e) {
    console.error(`[CF sync] write-back échoué pour la vidéo ${videoId}:`, e);
  }
}

// Appelée quand un job échoue. Marque la liaison comme "failed" côté ChannelFlow.
export async function markChannelFlowFailed(job: PipelineJob): Promise<void> {
  const videoId = job.params.channelflowVideoId;
  if (!videoId) return;
  const application = getApp();
  if (!application) return;
  try {
    await admin.firestore(application).collection("videos").doc(videoId).update({
      ffStatus: "failed",
      ffJobId: job.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error(`[CF sync] mark failed échoué pour la vidéo ${videoId}:`, e);
  }
}
