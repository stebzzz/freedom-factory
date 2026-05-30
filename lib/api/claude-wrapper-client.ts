// ===================================================================
// Claude wrapper client — routes ALL Anthropic calls through the VPS
// proxy at http://168.231.81.106:3000/api/claude (multipart/form-data).
// The proxy runs Claude Code CLI server-side to avoid paying API tokens.
//
// Trade-offs vs direct API :
// - No model / max_tokens / streaming controls (the wrapper ignores them)
// - Response is a single text string (we wrap it into ClaudeMessage shape
//   so the call-sites that do response.content[0].text keep working)
// - Latency 10-25s per call → concurrency capped at 3 to avoid VPS overload
// ===================================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";

const REQUEST_TIMEOUT_MS = 300_000; // 5 min — large script gens can return 30k+ chars

// ClaudeMessage shape kept identical to the original worker output so existing
// call-sites (response.content[0].text) work as-is.
export interface ClaudeMessage {
  content: Array<{ type: "text"; text: string }>;
}

export interface CallClaudeOptions {
  /** Optional path to an image file. The wrapper accepts png/jpg/jpeg. */
  imagePath?: string;
  /** Optional system prompt — prepended to the user content before sending. */
  system?: string;
  /** Optional model hint passed to the wrapper (e.g. "haiku" for fast bulk QC). */
  model?: string;
  /** Use the wider "light" concurrency lane (short arg-prompt calls — vision). */
  light?: boolean;
}

// ===================================================================
// Concurrency semaphore — STRICT serial queue (MAX_CONCURRENT = 1).
// The VPS Claude Code wrapper has a stdin race condition: when a second
// big-prompt POST arrives while the first is still writing stdin into the
// `claude` CLI, the CLI gives up after 3s ("no stdin data received in 3s")
// and returns HTTP 500. The fix that actually works is serialising calls
// on our side so the wrapper never sees more than one in-flight prompt.
// Wan / image gen are NOT affected and keep their own per-provider
// concurrency (lib/api/wan.ts, concurrency=3 by default).
// ===================================================================
const MAX_CONCURRENT = 1;
let inflight = 0;
const waitQueue: Array<() => void> = [];

// Separate, wider lane for "light" calls: short prompts sent as a CLI ARG
// (vision QC, classify, describe) — not via stdin — so the stdin race that
// forced the heavy lane to serial does NOT apply. Running these 3-wide cuts
// bulk image analysis from ~45min to ~15min for ~270 frames.
const LIGHT_MAX_CONCURRENT = 3;
let lightInflight = 0;
const lightQueue: Array<() => void> = [];

async function acquire(light = false): Promise<void> {
  if (light) {
    if (lightInflight < LIGHT_MAX_CONCURRENT) { lightInflight++; return; }
    await new Promise<void>((resolve) => lightQueue.push(resolve));
    lightInflight++;
    return;
  }
  if (inflight < MAX_CONCURRENT) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  inflight++;
}

function release(light = false): void {
  if (light) {
    lightInflight--;
    const next = lightQueue.shift();
    if (next) next();
    return;
  }
  inflight--;
  const next = waitQueue.shift();
  if (next) next();
}

// ===================================================================
// Helpers
// ===================================================================
function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase().replace(".", "");
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

// Flatten a messages[] array into a single prompt string. The wrapper exposes
// only one `prompt` field, so we concatenate (role tag + content) per message.
// For single-user-message calls (95% of our usage) this just returns the content.
function messagesToPrompt(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
  system?: string,
): string {
  const parts: string[] = [];
  if (system?.trim()) parts.push(system.trim());
  for (const m of messages) {
    const content = typeof m.content === "string"
      ? m.content
      : m.content.map((c) => c.text ?? "").filter(Boolean).join("\n");
    if (messages.length === 1 && !system) return content;
    parts.push(`[${m.role}]\n${content}`);
  }
  return parts.join("\n\n");
}

// ===================================================================
// Core call
// ===================================================================
async function callViaWrapper(prompt: string, imagePath?: string, model?: string, light = false): Promise<string> {
  const config = await getConfig();
  if (!config.claudeWrapperToken) {
    throw new Error("claudeWrapperToken manquant — défini CLAUDE_WRAPPER_TOKEN ou config/settings.json");
  }
  const url = config.claudeWrapperUrl;

  await acquire(light);
  try {
    const form = new FormData();
    form.append("token", config.claudeWrapperToken);
    form.append("prompt", prompt);
    // Optional model hint. The wrapper passes it through as `claude -p --model <model>`
    // when present; older wrappers that don't read this field just ignore it.
    // Used to route bulk vision QC to a fast model (haiku) instead of the default (Opus).
    if (model) form.append("model", model);

    if (imagePath) {
      const buffer = await readFile(imagePath);
      const blob = new Blob([new Uint8Array(buffer)], { type: mimeFromPath(imagePath) });
      form.append("image", blob, path.basename(imagePath));
    }

    const res = await fetch(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let data: { success?: boolean; response?: string; error?: string; details?: string };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new Error(`Wrapper HTTP ${res.status} — non-JSON body`);
    }

    if (!res.ok || !data.success) {
      const err: Error & { status?: number } = new Error(
        `Wrapper error ${res.status}: ${data.error ?? "unknown"}${data.details ? ` (${data.details.slice(0, 200)})` : ""}`,
      );
      err.status = res.status;
      throw err;
    }

    return data.response ?? "";
  } finally {
    release(light);
  }
}

// Map an Anthropic model id (e.g. "claude-sonnet-4-6") to the short family
// name the wrapper accepts as `claude -p --model <x>` (opus|sonnet|haiku).
// Anything unrecognised → undefined (wrapper falls back to its CLI default).
function toWrapperModel(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const m = modelId.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return undefined;
}

// ===================================================================
// PUBLIC: callClaude — drop-in for the old worker-SSE callClaude.
// `maxTokens` is accepted for compatibility but ignored (the wrapper
// handles it server-side). `model` IS honoured: an explicit options.model
// hint wins, otherwise the model id is mapped to opus/sonnet/haiku so the
// app's scriptModel setting actually routes the CLI (no longer a dead arg).
// ===================================================================
export async function callClaude(
  model: string,
  _maxTokens: number,
  messages: Array<{ role: string; content: string }>,
  options?: CallClaudeOptions,
): Promise<ClaudeMessage> {
  const prompt = messagesToPrompt(messages, options?.system);
  const wrapperModel = options?.model ?? toWrapperModel(model);
  const text = await callViaWrapper(prompt, options?.imagePath, wrapperModel, options?.light);
  return { content: [{ type: "text", text }] };
}

// ===================================================================
// PUBLIC: callClaudeRetry — retries 3x on network/5xx, throws on 4xx.
// ===================================================================
export async function callClaudeRetry(
  model: string,
  maxTokens: number,
  messages: Array<{ role: string; content: string }>,
  label = "Claude",
  options?: CallClaudeOptions,
): Promise<ClaudeMessage> {
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callClaude(model, maxTokens, messages, options);
    } catch (err: unknown) {
      lastErr = err as Error;
      const status = (err as { status?: number }).status;

      // 4xx → no retry (bad token, bad prompt format, etc.)
      if (status && status >= 400 && status < 500) {
        throw new Error(`[${label}] HTTP ${status}: ${(err as Error).message}`);
      }

      if (attempt < 3) {
        console.warn(`[${label}] tentative ${attempt}/3 échouée: ${(err as Error).message}`);
        console.warn(`[${label}] retry dans ${attempt * 3}s...`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
        continue;
      }
    }
  }

  throw new Error(`[${label}] ÉCHEC après 3 tentatives: ${lastErr?.message}`);
}

// ===================================================================
// PUBLIC: callClaudeWithImage — convenience for vision call-sites.
// Returns the raw text response (Haiku-style: single short text reply).
// ===================================================================
export async function callClaudeWithImage(
  prompt: string,
  imagePath: string,
  system?: string,
  label = "Claude Vision",
  model?: string,
): Promise<string> {
  const msg = await callClaudeRetry(
    "",
    0,
    [{ role: "user", content: prompt }],
    label,
    { imagePath, system, model, light: true },
  );
  return msg.content[0]?.text ?? "";
}
