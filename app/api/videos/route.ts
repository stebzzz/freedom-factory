import { NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const generatedDir = path.join(process.cwd(), "public", "generated");

    let dirs: string[];
    try {
      dirs = await readdir(generatedDir);
    } catch {
      return NextResponse.json([]);
    }

    const videos = [];

    for (const dir of dirs) {
      const videoPath = path.join(generatedDir, dir, "output.mp4");
      try {
        const stats = await stat(videoPath);
        videos.push({
          id: dir,
          videoUrl: `/generated/${dir}/output.mp4`,
          fileSize: stats.size,
          createdAt: stats.mtime.toISOString(),
        });
      } catch {
        // No video in this dir yet
      }
    }

    videos.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json(videos);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
