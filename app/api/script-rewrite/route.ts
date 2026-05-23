import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * POST /api/script-rewrite
 * Body: { segments: string[] }
 * Returns: { segments: { original: string, modified: string, wordsChanged: number }[] }
 *
 * Paraphrases ~10% of words in each segment using Claude.
 * Strict synonym-only replacement to avoid hallucinations.
 */
export async function POST(req: NextRequest) {
  try {
    const { segments } = (await req.json()) as { segments: string[] };

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return NextResponse.json({ error: "segments[] requis" }, { status: 400 });
    }

    const config = await getConfig();
    if (!config.anthropicKey) {
      return NextResponse.json({ error: "Cle API Anthropic manquante" }, { status: 500 });
    }

    // Process all segments in parallel
    const results = await Promise.all(
      segments.map((text) => paraphraseSegment(text, config.anthropicKey))
    );

    return NextResponse.json({ segments: results });
  } catch (err) {
    console.error("[script-rewrite] Error:", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

async function paraphraseSegment(
  text: string,
  apiKey: string,
): Promise<{ original: string; modified: string; wordsChanged: number }> {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const targetChanges = Math.max(1, Math.round(wordCount * 0.1));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("child_process") as typeof import("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("node:os");

  const ts = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const tmpDir = os.tmpdir();
  const tmpWorker = tmpDir + "/rewrite-w-" + ts + ".cjs";
  const tmpIn = tmpDir + "/rewrite-in-" + ts + ".json";
  const tmpOut = tmpDir + "/rewrite-out-" + ts + ".json";

  // Reuse the same worker pattern as claude.ts for Turbopack compatibility
  const WORKER_CODE = `
const https = require("node:https");
const fs = require("node:fs");
const inputFile = process.argv[2];
const outputFile = process.argv[3];
if (!inputFile || !outputFile) process.exit(1);
let parsed;
try { parsed = JSON.parse(fs.readFileSync(inputFile, "utf-8")); } catch (e) {
  fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: e.message }));
  process.exit(0);
}
const { model, maxTokens, messages, apiKey } = parsed;
const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
const req = https.request({
  hostname: "api.anthropic.com",
  path: "/v1/messages",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-length": Buffer.byteLength(body).toString(),
  },
}, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    const responseBody = Buffer.concat(chunks).toString("utf-8");
    if (res.statusCode >= 400) {
      fs.writeFileSync(outputFile, JSON.stringify({ success: false, status: res.statusCode, error: responseBody.slice(0, 500) }));
    } else {
      try {
        fs.writeFileSync(outputFile, JSON.stringify({ success: true, data: JSON.parse(responseBody) }));
      } catch (e) {
        fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: "Invalid JSON: " + responseBody.slice(0, 200) }));
      }
    }
  });
});
req.on("error", (err) => {
  fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: err.message }));
});
req.setTimeout(60000, () => {
  req.destroy();
  fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: "Timeout 60s" }));
});
req.write(body);
req.end();
`;

  fs.writeFileSync(tmpWorker, WORKER_CODE);
  fs.writeFileSync(
    tmpIn,
    JSON.stringify({
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      messages: [
        {
          role: "user",
          content: `Tu es un outil de paraphrase. Tu dois modifier EXACTEMENT ~${targetChanges} mots (10% du texte) en les remplacant par des synonymes.

REGLES STRICTES :
- Remplace ~${targetChanges} mots par des synonymes naturels
- NE CHANGE PAS le sens, la structure, ni la ponctuation
- NE RETIRE et N'AJOUTE aucune phrase
- Garde la meme longueur totale
- Reponds UNIQUEMENT avec le texte modifie, rien d'autre

TEXTE A MODIFIER :
${text}`,
        },
      ],
      apiKey,
    })
  );

  const child = cp.spawn(process.execPath, [tmpWorker, tmpIn, tmpOut], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll for output
  const maxWait = 60_000;
  const start = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(tmpOut)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start > maxWait) {
        clearInterval(timer);
        try { process.kill(child.pid!, "SIGTERM"); } catch { /* ok */ }
        reject(new Error("Paraphrase timeout (60s)"));
        return;
      }
    }, 300);
  });

  // Cleanup
  try { fs.unlinkSync(tmpWorker); } catch { /* ok */ }
  try { fs.unlinkSync(tmpIn); } catch { /* ok */ }

  const raw = fs.readFileSync(tmpOut, "utf-8");
  try { fs.unlinkSync(tmpOut); } catch { /* ok */ }

  const result = JSON.parse(raw);
  if (!result.success) {
    throw new Error("Paraphrase error: " + result.error);
  }

  const modified = (result.data as { content: Array<{ text: string }> }).content[0]?.text?.trim() || text;

  // Count actual word changes
  const origWords = text.split(/\s+/).filter(Boolean);
  const modWords = modified.split(/\s+/).filter(Boolean);
  let wordsChanged = 0;
  const minLen = Math.min(origWords.length, modWords.length);
  for (let i = 0; i < minLen; i++) {
    if (origWords[i].toLowerCase() !== modWords[i].toLowerCase()) wordsChanged++;
  }
  wordsChanged += Math.abs(origWords.length - modWords.length);

  return { original: text, modified, wordsChanged };
}
