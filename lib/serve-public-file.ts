// Read a file from a public/ subdirectory and stream it as an HTTP response.
//
// Why this exists: Next.js standalone scans public/ at startup and won't serve
// files added at runtime (pipeline outputs, kit imports, uploaded assets).
// The catch-all routes under app/{generated,uploads,sourcing,style-refs}/[...path]
// delegate to this helper so disk content is served regardless of build-time state.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
};

function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export async function servePublicFile(baseDir: string, parts: string[]): Promise<Response> {
  // Defense against path traversal: drop any segment with ".." or absolute path
  const safe = parts.filter((p) => p && !p.includes("..") && !p.startsWith("/") && !p.startsWith("\\"));
  if (safe.length === 0) return new Response("Bad path", { status: 400 });

  const fullPath = path.join(process.cwd(), "public", baseDir, ...safe);

  try {
    const st = await stat(fullPath);
    if (!st.isFile()) return new Response("Not a file", { status: 404 });
    const data = await readFile(fullPath);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeFor(path.extname(fullPath)),
        "Content-Length": st.size.toString(),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
