import { NextResponse } from "next/server";
import { listKits } from "@/lib/style-kit/import";

export const dynamic = "force-dynamic";

export async function GET() {
  const kits = await listKits();
  return NextResponse.json({ kits });
}
