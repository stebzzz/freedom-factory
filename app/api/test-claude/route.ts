import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

// Test 1: Direct await (should work)
export async function GET() {
  const results: Record<string, unknown> = {};

  try {
    const config = await getConfig();
    results.hasKey = !!config.anthropicKey;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("child_process") as typeof import("node:child_process");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("os") as typeof import("node:os");

    const ts = Date.now() + "_test";
    const tmpDir = os.tmpdir();
    const tmpWorker = tmpDir + "/claude-test-" + ts + ".cjs";
    const tmpIn = tmpDir + "/claude-test-in-" + ts + ".json";
    const tmpOut = tmpDir + "/claude-test-out-" + ts + ".json";

    const workerCode = `
const https = require("node:https");
const fs = require("node:fs");
const inputFile = process.argv[2];
const outputFile = process.argv[3];
const { apiKey } = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 50, messages: [{ role: "user", content: "Say OK in 2 words" }] });
const req = https.request({
  hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(body).toString() },
}, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    const r = Buffer.concat(chunks).toString("utf-8");
    if (res.statusCode >= 400) fs.writeFileSync(outputFile, JSON.stringify({ success: false, status: res.statusCode, error: r.slice(0, 300) }));
    else { try { fs.writeFileSync(outputFile, JSON.stringify({ success: true, data: JSON.parse(r) })); } catch(e) { fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: "bad json" })); } }
  });
});
req.on("error", (err) => fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: err.message })));
req.setTimeout(30000, () => { req.destroy(); fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: "timeout" })); });
req.write(body);
req.end();
`;

    fs.writeFileSync(tmpWorker, workerCode);
    fs.writeFileSync(tmpIn, JSON.stringify({ apiKey: config.anthropicKey }));

    // Use async execFile
    await new Promise<void>((resolve, reject) => {
      cp.execFile(process.execPath, [tmpWorker, tmpIn, tmpOut], {
        timeout: 60_000,
      }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    results.execOk = true;

    if (fs.existsSync(tmpOut)) {
      const raw = fs.readFileSync(tmpOut, "utf-8");
      results.output = JSON.parse(raw);
    } else {
      results.output = null;
    }

    // Cleanup
    try { fs.unlinkSync(tmpWorker); } catch { /* ok */ }
    try { fs.unlinkSync(tmpIn); } catch { /* ok */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ok */ }

  } catch (err) {
    results.error = (err as Error).message;
  }

  return NextResponse.json(results, { status: 200 });
}

// Test 2: Fire-and-forget (simulates pipeline behavior)
// POST /api/test-claude — starts bg task, returns immediately, writes result to /tmp
export async function POST(req: NextRequest) {
  const config = await getConfig();
  if (!config.anthropicKey) return NextResponse.json({ error: "no key" }, { status: 500 });

  const resultFile = "/tmp/test-bg-claude-result.json";

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("child_process") as typeof import("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("node:os");

  const ts = Date.now() + "_bg";
  const tmpDir = os.tmpdir();
  const tmpWorker = tmpDir + "/claude-bg-" + ts + ".cjs";
  const tmpIn = tmpDir + "/claude-bg-in-" + ts + ".json";
  const tmpOut = tmpDir + "/claude-bg-out-" + ts + ".json";

  const workerCode = `
const https = require("node:https");
const fs = require("node:fs");
const inputFile = process.argv[2];
const outputFile = process.argv[3];
const { apiKey } = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 50, messages: [{ role: "user", content: "Say BACKGROUND OK" }] });
const req = https.request({
  hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(body).toString() },
}, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    const r = Buffer.concat(chunks).toString("utf-8");
    if (res.statusCode >= 400) fs.writeFileSync(outputFile, JSON.stringify({ success: false, status: res.statusCode, error: r.slice(0, 300) }));
    else { try { fs.writeFileSync(outputFile, JSON.stringify({ success: true, data: JSON.parse(r) })); } catch(e) { fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: "bad json" })); } }
  });
});
req.on("error", (err) => fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: err.message })));
req.setTimeout(30000, () => { req.destroy(); fs.writeFileSync(outputFile, JSON.stringify({ success: false, error: "timeout" })); });
req.write(body);
req.end();
`;

  fs.writeFileSync(tmpWorker, workerCode);
  fs.writeFileSync(tmpIn, JSON.stringify({ apiKey: config.anthropicKey }));

  // FIRE-AND-FORGET — same pattern as pipeline
  (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        cp.execFile(process.execPath, [tmpWorker, tmpIn, tmpOut], {
          timeout: 60_000,
        }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      // Write final result
      if (fs.existsSync(tmpOut)) {
        const raw = fs.readFileSync(tmpOut, "utf-8");
        fs.writeFileSync(resultFile, JSON.stringify({ bg: true, ts: Date.now(), result: JSON.parse(raw) }, null, 2));
      } else {
        fs.writeFileSync(resultFile, JSON.stringify({ bg: true, error: "no output file" }));
      }
    } catch (err) {
      fs.writeFileSync(resultFile, JSON.stringify({ bg: true, error: (err as Error).message }));
    } finally {
      try { fs.unlinkSync(tmpWorker); } catch { /* ok */ }
      try { fs.unlinkSync(tmpIn); } catch { /* ok */ }
      try { fs.unlinkSync(tmpOut); } catch { /* ok */ }
    }
  })();

  // Return immediately — bg task runs independently
  return NextResponse.json({ message: "bg task started, check /tmp/test-bg-claude-result.json" });
}
