import { NextResponse } from "next/server";
import { importPdf } from "@/lib/style-kit/import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const fd = await req.formData();
  const pdf = fd.get("pdf");
  const rawSlug = (fd.get("slug") ?? "").toString();
  const rawMode = (fd.get("mode") ?? "classify").toString();
  const mode = rawMode === "describe" ? "describe" : "classify";

  if (!(pdf instanceof Blob)) {
    return NextResponse.json({ error: "champ 'pdf' manquant ou invalide" }, { status: 400 });
  }
  if (pdf.size === 0) {
    return NextResponse.json({ error: "PDF vide" }, { status: 400 });
  }
  if (pdf.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "PDF > 50 Mo refusé" }, { status: 400 });
  }
  if (!rawSlug.trim()) {
    return NextResponse.json({ error: "champ 'slug' manquant" }, { status: 400 });
  }

  const sourceName = pdf instanceof File ? pdf.name : undefined;
  const buffer = Buffer.from(await pdf.arrayBuffer());

  try {
    const meta = await importPdf(buffer, rawSlug, sourceName, mode);
    return NextResponse.json({ kit: meta });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[style-kit] import failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
