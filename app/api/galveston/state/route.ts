import { NextResponse } from "next/server";
import { loadProjectState } from "@/lib/galveston/runner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(loadProjectState());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
