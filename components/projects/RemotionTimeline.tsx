"use client";

import { useEffect, useRef, useState, useCallback, useMemo, type RefObject, type CSSProperties } from "react";
import type { PlayerRef } from "@remotion/player";
import { effectiveLength, type RemotionClip } from "@/remotion/types";

interface Props {
  clips: RemotionClip[];
  onClipsChange: (clips: RemotionClip[]) => void;
  fps: number;
  durationInFrames: number;
  playerRef: RefObject<PlayerRef | null>;
  selectedIds: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Open the scene modal for a clip (double-click on a clip block). */
  onClipOpen?: (clipId: string) => void;
  voiceoverUrl?: string;
  musicUrl?: string;
}

const DEFAULT_PX_PER_FRAME = 1.5;
const MIN_PX_PER_FRAME = 0.2;
const MAX_PX_PER_FRAME = 6;
const RULER_HEIGHT = 24;
const VIDEO_TRACK_HEIGHT = 60;
const AUDIO_TRACK_HEIGHT = 36;
const HEADER_WIDTH = 60;
const HANDLE_WIDTH = 6;
const MIN_CLIP_FRAMES = 4;
const SNAP_THRESHOLD_PX = 8;

type DragMode = "move" | "trim-start" | "trim-end";
interface ActiveDrag {
  mode: DragMode;
  clipId: string;
  initialPointerX: number;
  initialPointerY: number;
  initialStartFrame: number;
  initialTrackIndex: number;
  initialTrimStart: number;
  initialTrimEnd: number;
  durationInFrames: number;
  snappedX: number | null;
}

export function RemotionTimeline({
  clips,
  onClipsChange,
  fps,
  durationInFrames,
  playerRef,
  selectedIds,
  onSelectionChange,
  onClipOpen,
  voiceoverUrl,
  musicUrl,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const [pxPerFrame, setPxPerFrame] = useState(DEFAULT_PX_PER_FRAME);
  const [currentFrame, setCurrentFrame] = useState(0);
  const rafRef = useRef<number | null>(null);
  const [drag, setDrag] = useState<ActiveDrag | null>(null);

  // Poll the Player for the current frame.
  useEffect(() => {
    const tick = () => {
      const f = playerRef.current?.getCurrentFrame() ?? 0;
      setCurrentFrame(f);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [playerRef]);

  // Determine which video tracks to display (at least V1 and V2; expand if higher tracks exist).
  const maxVideoTrack = useMemo(() => {
    return clips.reduce((m, c) => Math.max(m, c.trackIndex), 0);
  }, [clips]);
  const videoTracks: number[] = useMemo(() => {
    // Always show at least 2 video tracks; expand if user dragged clips higher.
    const n = Math.max(2, maxVideoTrack + 2);
    const arr: number[] = [];
    for (let i = n - 1; i >= 0; i--) arr.push(i); // top-down so V_n on top
    return arr;
  }, [maxVideoTrack]);

  const audioTracks = useMemo(() => {
    const list: Array<{ id: string; label: string; color: string; url?: string }> = [];
    if (voiceoverUrl) list.push({ id: "voiceover", label: "A1", color: "rgba(98,167,255,0.18)", url: voiceoverUrl });
    if (musicUrl) list.push({ id: "music", label: "A2", color: "rgba(160,140,255,0.18)", url: musicUrl });
    return list;
  }, [voiceoverUrl, musicUrl]);

  const totalTrackHeight = videoTracks.length * VIDEO_TRACK_HEIGHT + audioTracks.length * AUDIO_TRACK_HEIGHT;
  const totalHeight = RULER_HEIGHT + totalTrackHeight;

  const videoTrackTop = (idx: number): number => {
    // Higher trackIndex → higher on screen (smaller top). videoTracks is sorted desc.
    const order = videoTracks.indexOf(idx);
    if (order < 0) return RULER_HEIGHT;
    return RULER_HEIGHT + order * VIDEO_TRACK_HEIGHT;
  };

  const audioTrackTop = (i: number): number => {
    return RULER_HEIGHT + videoTracks.length * VIDEO_TRACK_HEIGHT + i * AUDIO_TRACK_HEIGHT;
  };

  const tracksHeightPx = videoTracks.length * VIDEO_TRACK_HEIGHT;

  // Compute snap targets: every clip start, every clip end, the playhead, and frame 0.
  const snapTargets = useCallback((excludeId: string | null): number[] => {
    const targets = new Set<number>([0, currentFrame]);
    for (const c of clips) {
      if (c.id === excludeId) continue;
      targets.add(c.startFrame);
      targets.add(c.startFrame + effectiveLength(c));
    }
    return Array.from(targets).sort((a, b) => a - b);
  }, [clips, currentFrame]);

  // Snap a candidate frame value to the nearest target within SNAP_THRESHOLD_PX.
  const snap = useCallback((candidateFrame: number, excludeId: string | null): { value: number; snapped: number | null } => {
    const thresholdFrames = SNAP_THRESHOLD_PX / pxPerFrame;
    const targets = snapTargets(excludeId);
    let bestDiff = Infinity;
    let bestTarget: number | null = null;
    for (const t of targets) {
      const diff = Math.abs(candidateFrame - t);
      if (diff < bestDiff && diff <= thresholdFrames) {
        bestDiff = diff;
        bestTarget = t;
      }
    }
    if (bestTarget !== null) return { value: bestTarget, snapped: bestTarget };
    return { value: candidateFrame, snapped: null };
  }, [pxPerFrame, snapTargets]);

  // Determine which video track Y maps to.
  const yToVideoTrack = useCallback((relativeY: number): number => {
    if (relativeY < RULER_HEIGHT) return videoTracks[0]; // clamp to top
    const trackOrder = Math.floor((relativeY - RULER_HEIGHT) / VIDEO_TRACK_HEIGHT);
    const clamped = Math.max(0, Math.min(videoTracks.length - 1, trackOrder));
    return videoTracks[clamped];
  }, [videoTracks]);

  // ----- Drag handling ------------------------------------------------------
  const startDrag = useCallback((e: React.PointerEvent, clip: RemotionClip, mode: DragMode) => {
    e.stopPropagation();
    e.preventDefault();
    setDrag({
      mode,
      clipId: clip.id,
      initialPointerX: e.clientX,
      initialPointerY: e.clientY,
      initialStartFrame: clip.startFrame,
      initialTrackIndex: clip.trackIndex,
      initialTrimStart: clip.trimStartFrames ?? 0,
      initialTrimEnd: clip.trimEndFrames ?? clip.durationInFrames,
      durationInFrames: clip.durationInFrames,
      snappedX: null,
    });
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - drag.initialPointerX;
      const dxFrames = Math.round(dx / pxPerFrame);
      if (drag.mode === "move") {
        // Compute candidate start with snap.
        const candidateStart = drag.initialStartFrame + dxFrames;
        const snapStart = snap(candidateStart, drag.clipId);
        // Also try snapping the end edge.
        const length = (drag.initialTrimEnd - drag.initialTrimStart);
        const snapEnd = snap(candidateStart + length, drag.clipId);
        let finalStart = snapStart.value;
        let snappedX: number | null = snapStart.snapped !== null ? snapStart.snapped * pxPerFrame : null;
        if (snapStart.snapped === null && snapEnd.snapped !== null) {
          finalStart = snapEnd.value - length;
          snappedX = snapEnd.snapped * pxPerFrame;
        }
        finalStart = Math.max(0, finalStart);

        const containerRect = tracksRef.current?.getBoundingClientRect();
        const relativeY = containerRect ? ev.clientY - containerRect.top : 0;
        const newTrack = yToVideoTrack(relativeY);

        onClipsChange(clips.map((c) => c.id === drag.clipId
          ? { ...c, startFrame: finalStart, trackIndex: newTrack }
          : c));
        setDrag({ ...drag, snappedX });
      } else if (drag.mode === "trim-start") {
        const candidateTrim = drag.initialTrimStart + dxFrames;
        const clamped = Math.max(0, Math.min(drag.initialTrimEnd - MIN_CLIP_FRAMES, candidateTrim));
        // Also shift startFrame to keep the visual right edge in place.
        const newStartFrame = drag.initialStartFrame + (clamped - drag.initialTrimStart);
        onClipsChange(clips.map((c) => c.id === drag.clipId
          ? {
              ...c,
              trimStartFrames: clamped === 0 ? undefined : clamped,
              startFrame: Math.max(0, newStartFrame),
            }
          : c));
      } else if (drag.mode === "trim-end") {
        const candidateTrim = drag.initialTrimEnd + dxFrames;
        const clamped = Math.max(drag.initialTrimStart + MIN_CLIP_FRAMES, Math.min(drag.durationInFrames, candidateTrim));
        onClipsChange(clips.map((c) => c.id === drag.clipId
          ? { ...c, trimEndFrames: clamped === drag.durationInFrames ? undefined : clamped }
          : c));
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, pxPerFrame, snap, yToVideoTrack, clips, onClipsChange]);

  // ----- Ruler / playhead ----------------------------------------------------
  const seekToClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Ignore clicks that come from inside a clip block or its handles.
      if ((e.target as HTMLElement).closest("[data-clip-block]")) return;
      const rect = tracksRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const targetFrame = Math.max(0, Math.min(durationInFrames, Math.round(x / pxPerFrame)));
      playerRef.current?.seekTo(targetFrame);
      setCurrentFrame(targetFrame);
      onSelectionChange(new Set());
    },
    [durationInFrames, pxPerFrame, playerRef, onSelectionChange],
  );

  // Ruler ticks: aim for ~80px between major ticks.
  const tickInterval = useMemo(() => {
    const targetPx = 80;
    const sec = targetPx / (pxPerFrame * fps);
    if (sec <= 0.5) return 0.5;
    if (sec <= 1) return 1;
    if (sec <= 2) return 2;
    if (sec <= 5) return 5;
    if (sec <= 10) return 10;
    if (sec <= 30) return 30;
    return 60;
  }, [pxPerFrame, fps]);

  const totalSeconds = durationInFrames / fps;
  const ticks: number[] = [];
  for (let s = 0; s <= totalSeconds + 0.001; s += tickInterval) ticks.push(s);

  // Auto-scroll playhead.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || drag) return;
    const playheadX = currentFrame * pxPerFrame;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth - HEADER_WIDTH;
    if (playheadX < viewLeft + 40 || playheadX > viewRight - 40) {
      container.scrollTo({ left: Math.max(0, playheadX - container.clientWidth / 2), behavior: "smooth" });
    }
  }, [currentFrame, pxPerFrame, drag]);

  const timelineWidth = Math.max(1000, durationInFrames * pxPerFrame);
  const playheadLeft = currentFrame * pxPerFrame;

  return (
    <div className="glass-static p-0 overflow-hidden" style={{ borderRadius: "var(--radius-sm)" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-2.5" style={{ borderBottom: "1px solid var(--border-glass)" }}>
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="heading-md text-[14px]">Timeline</h2>
          <span className="mono-sm">{formatTC(currentFrame, fps)} / {formatTC(durationInFrames, fps)}</span>
          <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>
            {clips.length} clip{clips.length > 1 ? "s" : ""} · {selectedIds.size} sél.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="mono-sm">Zoom</label>
          <input type="range" min={MIN_PX_PER_FRAME} max={MAX_PX_PER_FRAME} step={0.1} value={pxPerFrame} onChange={(e) => setPxPerFrame(parseFloat(e.target.value))} style={{ width: 120 }} />
          <span className="mono-sm">{pxPerFrame.toFixed(1)}x</span>
        </div>
      </div>

      <div className="relative" style={{ background: "#0f0f14" }}>
        {/* Layout: fixed track-header column + scrollable timeline column */}
        <div ref={containerRef} className="overflow-x-auto overflow-y-hidden" style={{ display: "flex" }}>
          {/* Track header column (sticky left) */}
          <div
            className="flex-shrink-0 sticky left-0 z-30"
            style={{ width: HEADER_WIDTH, background: "#0f0f14", borderRight: "1px solid var(--border-glass)", height: totalHeight }}
          >
            <div style={{ height: RULER_HEIGHT, background: "rgba(0,0,0,0.4)" }} />
            {videoTracks.map((trackIdx) => (
              <div
                key={`vh-${trackIdx}`}
                className="flex items-center justify-center"
                style={{ height: VIDEO_TRACK_HEIGHT, borderTop: "1px solid var(--border-glass)" }}
              >
                <span className="mono-sm font-semibold" style={{ color: "var(--text-secondary)", fontSize: 11 }}>V{trackIdx + 1}</span>
              </div>
            ))}
            {audioTracks.map((track) => (
              <div
                key={`ah-${track.id}`}
                className="flex items-center justify-center"
                style={{ height: AUDIO_TRACK_HEIGHT, borderTop: "1px solid var(--border-glass)" }}
              >
                <span className="mono-sm font-semibold" style={{ color: "var(--text-secondary)", fontSize: 11 }}>{track.label}</span>
              </div>
            ))}
          </div>

          {/* Timeline content */}
          <div
            ref={tracksRef}
            className="relative"
            style={{ width: timelineWidth, height: totalHeight, cursor: drag ? (drag.mode === "move" ? "grabbing" : "ew-resize") : "default" }}
            onClick={seekToClick}
          >
            {/* Ruler */}
            <div className="absolute top-0 left-0 right-0 select-none" style={{ height: RULER_HEIGHT, background: "rgba(0,0,0,0.4)", borderBottom: "1px solid var(--border-glass)" }}>
              {ticks.map((s) => (
                <div
                  key={s}
                  className="absolute top-0 bottom-0 flex items-end pb-0.5 pl-1"
                  style={{ left: s * fps * pxPerFrame, borderLeft: "1px solid rgba(255,255,255,0.1)" }}
                >
                  <span className="mono-sm" style={{ color: "var(--text-tertiary)", fontSize: 10 }}>
                    {formatTC(Math.round(s * fps), fps)}
                  </span>
                </div>
              ))}
            </div>

            {/* Video track backgrounds (alternating) */}
            {videoTracks.map((trackIdx, order) => (
              <div
                key={`vb-${trackIdx}`}
                className="absolute left-0 right-0"
                style={{
                  top: RULER_HEIGHT + order * VIDEO_TRACK_HEIGHT,
                  height: VIDEO_TRACK_HEIGHT,
                  background: order % 2 === 0 ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.04)",
                  borderTop: "1px solid rgba(255,255,255,0.05)",
                }}
              />
            ))}

            {/* Audio track backgrounds */}
            {audioTracks.map((track, i) => (
              <div
                key={`ab-${track.id}`}
                className="absolute left-0 right-0"
                style={{
                  top: audioTrackTop(i),
                  height: AUDIO_TRACK_HEIGHT,
                  background: track.color,
                  borderTop: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <div className="px-2 py-1 mono-sm truncate" style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
                  {track.url}
                </div>
              </div>
            ))}

            {/* Video clips */}
            {clips.map((clip) => {
              const length = effectiveLength(clip);
              const left = clip.startFrame * pxPerFrame;
              const width = Math.max(8, length * pxPerFrame - 2);
              const top = videoTrackTop(clip.trackIndex) + 3;
              const selected = selectedIds.has(clip.id);
              const isBeingDragged = drag?.clipId === clip.id;
              return (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  fps={fps}
                  left={left}
                  top={top}
                  width={width}
                  height={VIDEO_TRACK_HEIGHT - 6}
                  selected={selected}
                  isBeingDragged={!!isBeingDragged}
                  onPointerDown={(e, mode) => startDrag(e, clip, mode)}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = new Set(selectedIds);
                    if (e.shiftKey) {
                      if (next.has(clip.id)) next.delete(clip.id); else next.add(clip.id);
                    } else {
                      next.clear();
                      next.add(clip.id);
                    }
                    onSelectionChange(next);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (onClipOpen) {
                      onClipOpen(clip.id);
                    } else {
                      playerRef.current?.seekTo(clip.startFrame);
                      setCurrentFrame(clip.startFrame);
                    }
                  }}
                />
              );
            })}

            {/* Snap indicator */}
            {drag?.snappedX !== null && drag?.snappedX !== undefined && (
              <div
                className="absolute top-0 pointer-events-none"
                style={{
                  left: drag.snappedX,
                  bottom: 0,
                  width: 1,
                  background: "var(--green, #5ce886)",
                  boxShadow: "0 0 6px rgba(92,232,134,0.8)",
                }}
              />
            )}

            {/* Playhead */}
            <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: playheadLeft, width: 2, background: "#ff5252", boxShadow: "0 0 6px rgba(255,82,82,0.7)", zIndex: 50 }}>
              <div className="absolute left-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45" style={{ background: "#ff5252", top: 0 }} />
            </div>
          </div>
        </div>
      </div>

      <div className="mono-sm flex flex-wrap gap-x-4 gap-y-1 px-4 py-2" style={{ color: "var(--text-tertiary)", borderTop: "1px solid var(--border-glass)" }}>
        <span>↔ glisser le centre = déplacer / changer de piste</span>
        <span>◀ ▶ glisser les bords = trim</span>
        <span>shift+clic = multi-sélection</span>
        <span>double-clic = ouvrir l&apos;éditeur de scène</span>
        <span>S = split au playhead</span>
        <span>Suppr = supprimer</span>
        <span style={{ color: "var(--green, #5ce886)" }}>● = snap actif</span>
      </div>
    </div>
  );
}

interface BlockProps {
  clip: RemotionClip;
  fps: number;
  left: number;
  top: number;
  width: number;
  height: number;
  selected: boolean;
  isBeingDragged: boolean;
  onPointerDown: (e: React.PointerEvent, mode: DragMode) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
}

function ClipBlock({ clip, fps, left, top, width, height, selected, isBeingDragged, onPointerDown, onClick, onDoubleClick }: BlockProps) {
  const length = effectiveLength(clip);
  const trimStart = clip.trimStartFrames ?? 0;
  const trimEnd = clip.trimEndFrames ?? clip.durationInFrames;
  const style: CSSProperties = {
    position: "absolute",
    left,
    top,
    width,
    height,
    background: selected ? "linear-gradient(180deg, #4d8fff 0%, #3d6fcc 100%)" : "linear-gradient(180deg, #2a3340 0%, #1f2530 100%)",
    border: `1px solid ${selected ? "#88b5ff" : "#3a4252"}`,
    borderRadius: 4,
    color: selected ? "white" : "rgba(255,255,255,0.9)",
    opacity: isBeingDragged ? 0.85 : 1,
    boxShadow: isBeingDragged
      ? "0 8px 24px rgba(0,0,0,0.6)"
      : selected ? "0 0 0 1px rgba(136,181,255,0.4)" : "inset 0 1px 0 rgba(255,255,255,0.05)",
    zIndex: isBeingDragged ? 40 : (selected ? 10 : 5),
    overflow: "hidden",
  };
  return (
    <div
      data-clip-block
      style={style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Left trim handle */}
      <div
        onPointerDown={(e) => onPointerDown(e, "trim-start")}
        title="Trim début"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: HANDLE_WIDTH,
          cursor: "ew-resize",
          background: selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.08)",
          borderRadius: "3px 0 0 3px",
        }}
      />
      {/* Middle: drag-to-move */}
      <div
        onPointerDown={(e) => onPointerDown(e, "move")}
        style={{
          position: "absolute",
          left: HANDLE_WIDTH,
          right: HANDLE_WIDTH,
          top: 0,
          bottom: 0,
          cursor: "grab",
          padding: "5px 6px",
          touchAction: "none",
        }}
      >
        <div className="text-[11px] font-semibold truncate pointer-events-none" style={{ textShadow: "0 1px 1px rgba(0,0,0,0.5)" }}>
          {clip.label ?? "clip"}
        </div>
        <div className="pointer-events-none mono-sm" style={{ color: selected ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)", fontSize: 10 }}>
          {formatTC(length, fps)}
          {(trimStart > 0 || trimEnd < clip.durationInFrames) && (
            <span> · trim {formatTC(trimStart, fps)}→{formatTC(trimEnd, fps)}</span>
          )}
        </div>
        {/* Mini "filmstrip" effect: a subtle dot pattern at the bottom edge */}
        <div className="pointer-events-none absolute left-1 right-1" style={{ bottom: 3, height: 2, background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)", borderRadius: 1 }} />
      </div>
      {/* Right trim handle */}
      <div
        onPointerDown={(e) => onPointerDown(e, "trim-end")}
        title="Trim fin"
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: HANDLE_WIDTH,
          cursor: "ew-resize",
          background: selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.08)",
          borderRadius: "0 3px 3px 0",
        }}
      />
    </div>
  );
}

// HH:MM:SS:FF timecode, DaVinci-style.
function formatTC(frames: number, fps: number): string {
  const totalSec = Math.floor(frames / fps);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const f = Math.floor(frames - totalSec * fps);
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
  return `${pad(m)}:${pad(s)}:${pad(f)}`;
}
function pad(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}
