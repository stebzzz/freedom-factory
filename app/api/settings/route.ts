import { NextRequest, NextResponse } from "next/server";
import { getConfig, saveConfig, maskKey } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = await getConfig();

  // Return config with keys masked for security
  return NextResponse.json({
    ...config,
    anthropicKey:   maskKey(config.anthropicKey),
    siliconflowKey: maskKey(config.siliconflowKey),
    genaiproKey:    maskKey(config.genaiproKey),
    elevenlabsKey:  maskKey(config.elevenlabsKey),
    mubertKey:      maskKey(config.mubertKey),
    sunoKey:        maskKey(config.sunoKey),
    pexelsKey:      maskKey(config.pexelsKey),
    pixabayKey:     maskKey(config.pixabayKey),
    unsplashKey:    maskKey(config.unsplashKey),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Only accept known keys; strip masked placeholders (don't overwrite with "••••••••xxxx")
  const updates: Record<string, string> = {};
  const keyFields = ["anthropicKey", "siliconflowKey", "genaiproKey", "elevenlabsKey", "elevenlabsVoiceId", "mubertKey", "sunoKey", "pexelsKey", "pixabayKey", "unsplashKey"];
  const modelFields = ["voiceModel", "scriptModel", "musicService"];

  for (const field of keyFields) {
    if (field in body) {
      const val = body[field] as string;
      // Only save if it's a real value (not a masked placeholder)
      if (val && !val.startsWith("••")) {
        updates[field] = val;
      }
    }
  }

  for (const field of modelFields) {
    if (field in body) {
      updates[field] = body[field];
    }
  }

  const saved = await saveConfig(updates);

  return NextResponse.json({ ok: true, voiceModel: saved.voiceModel, scriptModel: saved.scriptModel });
}
