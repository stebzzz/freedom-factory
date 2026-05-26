import { NextRequest, NextResponse } from "next/server";
import { addToQueue, startQueueWorker } from "@/lib/pipeline/queue";
import type { PipelineJobParams } from "@/lib/pipeline/types";
import { listKits } from "@/lib/style-kit/import";
import { loadAllPresets } from "@/lib/presets/custom-presets-store";

// Endpoint d'intégration appelé par ChannelFlow (navigateur) au passage d'une
// vidéo en "production". Authentifié par token Bearer + CORS allowlist.
// Les paramètres de production sont FORCÉS ici (voix ElevenLabs, images
// statiques WAN 2.7) — ChannelFlow n'envoie que ce qui dépend de la vidéo.
//
// Le job est ajouté à la queue (status "waiting"). Si le worker FF est en pause
// (workerEnabled=false), il y reste jusqu'à reprise manuelle.

// Réveille le singleton worker au 1er hit après un boot (reste en pause si désactivé).
startQueueWorker().catch((e) => console.error("[CF integration] worker start failed", e));

const DEFAULT_ORIGINS = [
  "https://channelflow-5d14a.web.app",
  "https://channelflow-5d14a.firebaseapp.com",
  "http://localhost:3000",
  "http://localhost:3001",
];

function allowedOrigins(): string[] {
  const env = process.env.CHANNELFLOW_ALLOWED_ORIGINS;
  if (env && env.trim()) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_ORIGINS;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const list = allowedOrigins();
  const allow = origin && list.includes(origin) ? origin : list[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function tokenOk(request: NextRequest): boolean {
  const expected = process.env.CHANNELFLOW_API_TOKEN;
  if (!expected) return false; // non configuré → on refuse par sécurité
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === expected;
}

interface CFPayload {
  title?: string;
  niche?: string;
  customScript?: string;
  duration?: number;
  presetId?: string;
  styleKitSlug?: string;
  voix?: string;
  channelflowVideoId?: string;
  channelflowChannelId?: string;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

// GET → métadonnées pour peupler le ChannelForm (style kits + presets), avec CORS
// + token (les routes /api/style-kit et /api/presets n'ont pas de CORS).
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request.headers.get("origin"));
  if (!tokenOk(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: cors });
  }
  try {
    const [kits, presets] = await Promise.all([listKits(), loadAllPresets()]);
    const styleKits = (kits as Array<{ slug: string; previewUrl?: string; mode?: string }>).map((k) => ({
      slug: k.slug,
      previewUrl: k.previewUrl,
      mode: k.mode,
    }));
    const presetList = (presets as Array<{ id: string; label: string; emoji?: string }>).map((p) => ({
      id: p.id,
      label: p.label,
      emoji: p.emoji,
    }));
    return NextResponse.json({ styleKits, presets: presetList }, { headers: cors });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CF integration GET]", msg);
    return NextResponse.json({ error: msg }, { status: 500, headers: cors });
  }
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request.headers.get("origin"));

  if (!tokenOk(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: cors });
  }

  let body: CFPayload;
  try {
    body = (await request.json()) as CFPayload;
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400, headers: cors });
  }

  const title = (body.title ?? "").trim();
  const niche = (body.niche ?? "").trim();
  const customScript = (body.customScript ?? "").trim();
  if (!title || !niche) {
    return NextResponse.json({ error: "title et niche requis" }, { status: 400, headers: cors });
  }
  if (!customScript) {
    return NextResponse.json({ error: "customScript (script) requis" }, { status: 400, headers: cors });
  }

  const duration =
    typeof body.duration === "number" && Number.isFinite(body.duration) && body.duration > 0
      ? body.duration
      : 10;

  const params: PipelineJobParams = {
    title,
    niche,
    description: "",
    // Voix ElevenLabs par chaîne si fournie (ID brut), sinon "" → la voix globale
    // ELEVENLABS_VOICE_ID est utilisée (cf. lib/api/elevenlabs.ts).
    voix: body.voix && body.voix.trim() ? body.voix.trim() : "",
    duration,
    scenario: "A",
    presetId: body.presetId?.trim() || undefined,
    customScript,
    // --- Paramètres de production figés (intégration ChannelFlow) ---
    voiceModel: "elevenlabs",
    videoMode: "static-images",
    imageProvider: "wan",
    wanModel: "wan2.7-image",
    styleKitSlug: body.styleKitSlug?.trim() || "style-kit-def",
    subtitlesEnabled: true,
    // --- Liaison retour ---
    channelflowVideoId: body.channelflowVideoId?.trim() || undefined,
    channelflowChannelId: body.channelflowChannelId?.trim() || undefined,
  };

  try {
    await startQueueWorker();
    const entry = await addToQueue(params);
    return NextResponse.json(
      { entry: { id: entry.id, jobId: entry.jobId ?? null, status: entry.status } },
      { headers: cors },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CF integration POST]", msg);
    return NextResponse.json({ error: msg }, { status: 500, headers: cors });
  }
}
