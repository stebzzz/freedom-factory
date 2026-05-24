import { NextResponse } from "next/server";
import { callClaudeRetry } from "@/lib/api/claude-wrapper-client";

export const dynamic = "force-dynamic";

/**
 * GET /api/test-claude — smoke test for the VPS Claude wrapper.
 * Sends a trivial prompt and returns the round-trip time + response.
 */
export async function GET() {
  const started = Date.now();
  try {
    const response = await callClaudeRetry(
      "claude-sonnet-4-6",
      50,
      [{ role: "user", content: "Reply with the two words: WRAPPER OK" }],
      "Wrapper Smoke",
    );
    const text = response.content[0]?.text?.trim() ?? "";
    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - started,
      text,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      elapsedMs: Date.now() - started,
      error: (err as Error).message,
    }, { status: 500 });
  }
}

/**
 * POST /api/test-claude — same smoke test but fire-and-forget, writing the
 * result to /tmp/test-bg-claude-result.json once done. Mirrors the original
 * pipeline-style background invocation so we can verify the wrapper survives
 * being called from a non-blocking context.
 */
export async function POST() {
  const resultFile = "/tmp/test-bg-claude-result.json";

  (async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("node:fs");
    const started = Date.now();
    try {
      const response = await callClaudeRetry(
        "claude-sonnet-4-6",
        50,
        [{ role: "user", content: "Reply with: BACKGROUND OK" }],
        "Wrapper Smoke BG",
      );
      const text = response.content[0]?.text?.trim() ?? "";
      fs.writeFileSync(resultFile, JSON.stringify({
        bg: true,
        ts: Date.now(),
        elapsedMs: Date.now() - started,
        text,
      }, null, 2));
    } catch (err) {
      fs.writeFileSync(resultFile, JSON.stringify({
        bg: true,
        ts: Date.now(),
        elapsedMs: Date.now() - started,
        error: (err as Error).message,
      }, null, 2));
    }
  })();

  return NextResponse.json({ message: "bg task started, check /tmp/test-bg-claude-result.json" });
}
