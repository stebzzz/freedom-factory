import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/pipeline/runner";

// Drop a decision on a job blocked at the voiceover gate.
// Body: { jobId: string, decision: "approve" | "regenerate" | "cancel", overrides?: { voix?, voiceModel?, genaiproTTSModel?, voiceSpeed? } }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      jobId?: string;
      decision?: "approve" | "regenerate" | "cancel";
      overrides?: {
        voix?: string;
        voiceModel?: "genaipro" | "elevenlabs" | "fishspeech";
        genaiproTTSModel?: "eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_flash_v2_5" | "eleven_v3";
        voiceSpeed?: number;
      };
    };
    const jobId = body.jobId;
    const decision = body.decision;
    if (!jobId) return NextResponse.json({ error: "jobId requis" }, { status: 400 });
    if (decision !== "approve" && decision !== "regenerate" && decision !== "cancel") {
      return NextResponse.json({ error: "decision doit être approve | regenerate | cancel" }, { status: 400 });
    }
    const job = getJob(jobId);
    if (!job) return NextResponse.json({ error: `job ${jobId} introuvable` }, { status: 404 });
    if (!job.awaitingVoiceoverApproval) {
      return NextResponse.json({ error: `job ${jobId} n'attend pas de validation voix off` }, { status: 409 });
    }
    job.voiceoverDecision = decision;
    if (decision === "regenerate" && body.overrides) {
      const o = body.overrides;
      job.voiceoverOverrides = {
        ...(o.voix ? { voix: o.voix } : {}),
        ...(o.voiceModel ? { voiceModel: o.voiceModel } : {}),
        ...(o.genaiproTTSModel ? { genaiproTTSModel: o.genaiproTTSModel } : {}),
        ...(typeof o.voiceSpeed === "number" ? { voiceSpeed: Math.max(0.7, Math.min(1.2, o.voiceSpeed)) } : {}),
      };
    }
    console.log(`[API voiceover-decision] ${jobId} → ${decision}${job.voiceoverOverrides ? ` (overrides=${JSON.stringify(job.voiceoverOverrides)})` : ""}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[API /pipeline/voiceover-decision]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
