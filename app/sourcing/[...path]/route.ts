import { servePublicFile } from "@/lib/serve-public-file";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return servePublicFile("sourcing", path);
}
