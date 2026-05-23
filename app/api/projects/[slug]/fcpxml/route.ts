import { NextResponse } from "next/server";
import path from "path";
import { existsSync } from "fs";
import { FPS, WIDTH, HEIGHT, effectiveLength } from "@/remotion/types";
import type { MontageCompositionProps, RemotionClip } from "@/remotion/types";

export const dynamic = "force-dynamic";

// Generate Final Cut Pro XML (FCPXML) 1.10 — importable in DaVinci Resolve,
// Premiere Pro, and Final Cut Pro. We keep this conservative: single sequence,
// optional secondary lanes for higher tracks (V2, V3...), all asset refs point
// to local files via file:// URLs so the importing app can relink them.
//
// Spec reference: https://developer.apple.com/documentation/professional_video_applications/fcpxml_reference

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let body: { composition?: MontageCompositionProps; projectName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  if (!body.composition || !Array.isArray(body.composition.clips)) {
    return NextResponse.json({ error: "composition.clips manquant" }, { status: 400 });
  }
  const comp = body.composition;
  const projectName = (body.projectName ?? slug).replace(/[<>&"']/g, "_");

  const projectRoot = process.cwd();

  // De-dupe assets by URL. Each unique source video gets one <asset>.
  const assetMap = new Map<string, { id: string; absPath: string; durationFrames: number; name: string }>();
  let assetCounter = 2; // r1 = format
  for (const c of comp.clips) {
    if (assetMap.has(c.url)) continue;
    const cleaned = c.url.startsWith("/") ? c.url.slice(1) : c.url;
    const absPath = /^[a-z]+:\/\//i.test(c.url) ? c.url : path.join(projectRoot, "public", cleaned);
    assetMap.set(c.url, {
      id: `r${assetCounter++}`,
      absPath,
      durationFrames: c.durationInFrames,
      name: (c.label ?? "clip").replace(/[<>&"']/g, "_"),
    });
  }

  // Optional audio assets (voiceover + music).
  let voiceoverAsset: { id: string; absPath: string; name: string } | null = null;
  if (comp.voiceoverUrl) {
    const url = comp.voiceoverUrl;
    const cleaned = url.startsWith("/") ? url.slice(1) : url;
    const absPath = /^[a-z]+:\/\//i.test(url) ? url : path.join(projectRoot, "public", cleaned);
    voiceoverAsset = { id: `r${assetCounter++}`, absPath, name: "Voiceover" };
  }
  let musicAsset: { id: string; absPath: string; name: string } | null = null;
  if (comp.musicUrl) {
    const url = comp.musicUrl;
    const cleaned = url.startsWith("/") ? url.slice(1) : url;
    const absPath = /^[a-z]+:\/\//i.test(url) ? url : path.join(projectRoot, "public", cleaned);
    musicAsset = { id: `r${assetCounter++}`, absPath, name: "Music" };
  }

  // Calculate total duration in frames.
  const totalFrames = Math.max(1, comp.clips.reduce((m, c) => Math.max(m, c.startFrame + effectiveLength(c)), 0));

  // Split clips into "spine" (V1 = trackIndex 0) and "lanes" (V2+ = trackIndex ≥ 1).
  // FCPXML's spine is the primary track; clips at lane > 0 are connected above.
  const sortedClips = [...comp.clips].sort((a, b) => a.startFrame - b.startFrame);
  const spineClips = sortedClips.filter((c) => c.trackIndex === 0);
  const laneClips = sortedClips.filter((c) => c.trackIndex > 0);

  const frameDurationStr = `1/${FPS}s`;

  const formatXml = (frames: number) => `${frames}/${FPS}s`;

  const xmlLines: string[] = [];
  xmlLines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  xmlLines.push(`<!DOCTYPE fcpxml>`);
  xmlLines.push(`<fcpxml version="1.10">`);
  xmlLines.push(`  <resources>`);
  xmlLines.push(`    <format id="r1" name="FFVideoFormat${WIDTH}x${HEIGHT}@${FPS}" frameDuration="${frameDurationStr}" width="${WIDTH}" height="${HEIGHT}"/>`);
  for (const a of assetMap.values()) {
    const src = pathToFileUrl(a.absPath);
    const exists = !/^[a-z]+:\/\//i.test(a.absPath) || existsSync(a.absPath);
    xmlLines.push(`    <asset id="${a.id}" name="${a.name}" src="${src}" hasVideo="1" hasAudio="1" duration="${formatXml(a.durationFrames)}" format="r1" videoSources="1" audioSources="1"${exists ? "" : " offlinePath=\"true\""}/>`);
  }
  if (voiceoverAsset) {
    xmlLines.push(`    <asset id="${voiceoverAsset.id}" name="${voiceoverAsset.name}" src="${pathToFileUrl(voiceoverAsset.absPath)}" hasAudio="1" audioSources="1" duration="${formatXml(totalFrames)}"/>`);
  }
  if (musicAsset) {
    xmlLines.push(`    <asset id="${musicAsset.id}" name="${musicAsset.name}" src="${pathToFileUrl(musicAsset.absPath)}" hasAudio="1" audioSources="1" duration="${formatXml(totalFrames)}"/>`);
  }
  xmlLines.push(`  </resources>`);
  xmlLines.push(`  <library>`);
  xmlLines.push(`    <event name="${projectName}">`);
  xmlLines.push(`      <project name="${projectName}">`);
  xmlLines.push(`        <sequence format="r1" duration="${formatXml(totalFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`);
  xmlLines.push(`          <spine>`);

  // Emit spine clips (V1). For gaps between clips, use <gap> elements.
  let cursor = 0;
  for (const clip of spineClips) {
    if (clip.startFrame > cursor) {
      const gapLen = clip.startFrame - cursor;
      xmlLines.push(`            <gap name="gap" offset="${formatXml(cursor)}" start="0s" duration="${formatXml(gapLen)}"/>`);
    }
    emitAssetClip(xmlLines, clip, assetMap, 14, 0);
    cursor = clip.startFrame + effectiveLength(clip);
  }
  if (totalFrames > cursor) {
    const tailGap = totalFrames - cursor;
    xmlLines.push(`            <gap name="gap" offset="${formatXml(cursor)}" start="0s" duration="${formatXml(tailGap)}"/>`);
  }

  // Connected clips for higher video tracks (V2+).
  for (const clip of laneClips) {
    emitAssetClip(xmlLines, clip, assetMap, 12, clip.trackIndex);
  }

  // Connected audio clips for voiceover + music (lane -1, -2 below the spine).
  if (voiceoverAsset) {
    xmlLines.push(`            <asset-clip ref="${voiceoverAsset.id}" lane="-1" offset="0s" start="0s" duration="${formatXml(totalFrames)}" name="Voiceover" audioRole="dialogue.dialogue"/>`);
  }
  if (musicAsset) {
    xmlLines.push(`            <asset-clip ref="${musicAsset.id}" lane="-2" offset="0s" start="0s" duration="${formatXml(totalFrames)}" name="Music" audioRole="music.music"/>`);
  }

  xmlLines.push(`          </spine>`);
  xmlLines.push(`        </sequence>`);
  xmlLines.push(`      </project>`);
  xmlLines.push(`    </event>`);
  xmlLines.push(`  </library>`);
  xmlLines.push(`</fcpxml>`);

  const xml = xmlLines.join("\n");
  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${projectName}.fcpxml"`,
    },
  });
}

function emitAssetClip(
  lines: string[],
  clip: RemotionClip,
  assetMap: Map<string, { id: string }>,
  indent: number,
  lane: number,
): void {
  const asset = assetMap.get(clip.url);
  if (!asset) return;
  const length = effectiveLength(clip);
  const trimStart = clip.trimStartFrames ?? 0;
  const indentStr = " ".repeat(indent);
  const laneAttr = lane > 0 ? ` lane="${lane}"` : "";
  const name = (clip.label ?? "clip").replace(/[<>&"']/g, "_");
  lines.push(`${indentStr}<asset-clip ref="${asset.id}" name="${name}"${laneAttr} offset="${frameStr(clip.startFrame)}" start="${frameStr(trimStart)}" duration="${frameStr(length)}"/>`);
}

function frameStr(frames: number): string {
  return `${Math.max(0, Math.round(frames))}/${FPS}s`;
}

function pathToFileUrl(p: string): string {
  if (/^[a-z]+:\/\//i.test(p)) return p;
  const normalized = p.replace(/\\/g, "/");
  return `file://${encodeURI(normalized)}`;
}
