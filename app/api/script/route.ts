import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  const format = req.nextUrl.searchParams.get("format") || "json";

  if (!jobId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const jobDir = path.join(process.cwd(), "public", "generated", jobId);

  try {
    if (format === "txt") {
      const txt = await readFile(path.join(jobDir, "script.txt"), "utf-8");
      return new Response(txt, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const json = await readFile(path.join(jobDir, "script.json"), "utf-8");
    return NextResponse.json(JSON.parse(json));
  } catch {
    return NextResponse.json({ error: "Script not found" }, { status: 404 });
  }
}
