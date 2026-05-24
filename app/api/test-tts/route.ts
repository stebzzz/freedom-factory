// Quick sanity-check route for the TTS pipeline.
//   GET  /api/test-tts                    → short hardcoded sample, ElevenLabs backend
//   POST /api/test-tts  body: { text?, voix?, backend? }
// Returns the absolute path of the generated mp3 + bytes + elapsed ms.
import { NextRequest, NextResponse } from "next/server";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateVoiceover } from "@/lib/api/voiceover";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

async function run(text: string, voix: string, backend: "elevenlabs" | "genaipro" | "fishspeech") {
  const dir = await mkdtemp(path.join(tmpdir(), "tts-test-"));
  const out = path.join(dir, "out.mp3");
  const t0 = Date.now();
  const result = await generateVoiceover(text, voix, out, { voiceModel: backend });
  const elapsedMs = Date.now() - t0;
  const sizeBytes = (await stat(result.audioPath).catch(() => ({ size: 0 } as { size: number }))).size;
  return { ok: true, ...result, elapsedMs, sizeBytes, chars: text.length };
}

export async function GET() {
  try {
    const text = "Hello, this is a short two second test from the TTS pipeline.";
    const res = await run(text, "male-en", "elevenlabs");
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, string>));
    const text = body.text || "Hello, this is a short test from the TTS pipeline.";
    const voix = body.voix || "male-en";
    const backend = (body.backend as "elevenlabs" | "genaipro" | "fishspeech" | undefined) || "elevenlabs";
    const res = await run(text, voix, backend);
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
