"use client";

import { use, useEffect, useMemo, useRef, useState, useCallback, type ComponentType } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ChevronLeft, Play, Loader2, Volume2, VolumeX, Film, RefreshCw, Scissors, Trash2, RotateCcw, FileDown } from "lucide-react";
import type { PlayerRef } from "@remotion/player";
import { MontageComposition } from "@/remotion/MontageComposition";
import { FPS, HEIGHT, WIDTH, effectiveLength } from "@/remotion/types";
import type { MontageCompositionProps, RemotionClip } from "@/remotion/types";
import { RemotionTimeline } from "@/components/projects/RemotionTimeline";
import { SceneModal } from "@/components/projects/SceneModal";

// @remotion/player is browser-only — disable SSR to avoid hydration issues.
const Player = dynamic(() => import("@remotion/player").then((m) => m.Player), {
  ssr: false,
  loading: () => (
    <div className="aspect-video w-full flex items-center justify-center glass-static">
      <Loader2 size={20} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
    </div>
  ),
});

interface RemotionDataResponse {
  project: { slug: string; label: string; description?: string };
  composition: MontageCompositionProps;
  meta: {
    fps: number;
    totalFrames: number;
    totalSeconds: number;
    clipCount: number;
    sceneCount: number;
    missingClips: number;
  };
}

export default function ProjectEditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [data, setData] = useState<RemotionDataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [composition, setComposition] = useState<MontageCompositionProps | null>(null);
  const [renderState, setRenderState] = useState<
    { phase: "idle" } | { phase: "running"; progress: number; message: string } | { phase: "done"; outputUrl: string } | { phase: "error"; message: string }
  >({ phase: "idle" });
  const playerRef = useRef<PlayerRef | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [serverComposition, setServerComposition] = useState<MontageCompositionProps | null>(null); // pristine copy for Reset
  const [modalClipId, setModalClipId] = useState<string | null>(null);

  // Fetch the composition from the API. On first load, also restore any
  // locally-edited composition from localStorage so the user keeps their
  // in-progress edits across reloads.
  useEffect(() => {
    let aborted = false;
    setLoading(true);
    fetch(`/api/projects/${slug}/remotion-data`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<RemotionDataResponse>;
      })
      .then((d) => {
        if (aborted) return;
        setData(d);
        setServerComposition(d.composition);
        // Restore from localStorage if present + still valid (clip ids overlap server).
        const stored = readStoredComposition(slug);
        if (stored && stored.clips.length > 0) {
          setComposition(stored);
        } else {
          setComposition(d.composition);
        }
      })
      .catch((e) => { if (!aborted) setError((e as Error).message); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [slug]);

  // Persist composition edits to localStorage (debounced).
  useEffect(() => {
    if (!composition) return;
    const handle = setTimeout(() => writeStoredComposition(slug, composition), 250);
    return () => clearTimeout(handle);
  }, [composition, slug]);

  const durationInFrames = useMemo(() => {
    if (!composition) return 1;
    let max = 0;
    for (const c of composition.clips) {
      const end = c.startFrame + effectiveLength(c);
      if (end > max) max = end;
    }
    return Math.max(1, max);
  }, [composition]);

  const setProp = <K extends keyof MontageCompositionProps>(key: K, value: MontageCompositionProps[K]) => {
    setComposition((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const setClips = useCallback((clips: RemotionClip[]) => {
    setComposition((prev) => (prev ? { ...prev, clips } : prev));
  }, []);

  const deleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    setComposition((prev) => {
      if (!prev) return prev;
      return { ...prev, clips: prev.clips.filter((c) => !selectedIds.has(c.id)) };
    });
    setSelectedIds(new Set());
  }, [selectedIds]);

  const splitAtPlayhead = useCallback(() => {
    if (!composition) return;
    const currentFrame = playerRef.current?.getCurrentFrame() ?? 0;
    const next: RemotionClip[] = [];
    let changed = false;
    for (const clip of composition.clips) {
      const length = effectiveLength(clip);
      const segStart = clip.startFrame;
      const segEnd = clip.startFrame + length;
      if (currentFrame > segStart + 2 && currentFrame < segEnd - 2) {
        const trimStart = clip.trimStartFrames ?? 0;
        const splitOffset = currentFrame - segStart; // frames into the visible portion
        const cutInSource = trimStart + splitOffset;
        const leftClip: RemotionClip = {
          ...clip,
          id: `${clip.id}_a${Date.now()}`,
          trimStartFrames: trimStart === 0 ? undefined : trimStart,
          trimEndFrames: cutInSource,
        };
        const rightClip: RemotionClip = {
          ...clip,
          id: `${clip.id}_b${Date.now()}`,
          trimStartFrames: cutInSource,
          trimEndFrames: clip.trimEndFrames,
          startFrame: currentFrame,
        };
        next.push(leftClip, rightClip);
        changed = true;
      } else {
        next.push(clip);
      }
    }
    if (changed) {
      setComposition({ ...composition, clips: next });
    }
  }, [composition]);

  const resetComposition = useCallback(() => {
    if (!serverComposition) return;
    if (!confirm("Réinitialiser le montage à l'état du serveur ? Les modifications locales seront perdues.")) return;
    setComposition(serverComposition);
    setSelectedIds(new Set());
    clearStoredComposition(slug);
  }, [serverComposition, slug]);

  const exportFcpxml = useCallback(async () => {
    if (!composition) return;
    try {
      const res = await fetch(`/api/projects/${slug}/fcpxml`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition, projectName: data?.project.label ?? slug }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}.fcpxml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export FCPXML échoué : ${(e as Error).message}`);
    }
  }, [composition, slug, data]);

  // Keyboard shortcuts: Delete = delete selection, S = split at playhead.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "s" || e.key === "S") {
        splitAtPlayhead();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIds, deleteSelected, splitAtPlayhead]);

  const startRender = async () => {
    if (!composition) return;
    setRenderState({ phase: "running", progress: 0, message: "Démarrage du render..." });
    try {
      const res = await fetch(`/api/projects/${slug}/remotion-render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composition }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const { outputUrl } = await res.json();
      setRenderState({ phase: "done", outputUrl });
    } catch (e) {
      setRenderState({ phase: "error", message: (e as Error).message });
    }
  };

  if (loading) {
    return <div className="glass-static py-16 text-center mono-sm">chargement…</div>;
  }
  if (error || !data || !composition) {
    return (
      <div className="glass-static py-6 px-5" style={{ color: "var(--red)" }}>
        {error || "Données indisponibles"}
        <div className="mt-4">
          <Link href={`/projects/${slug}`} className="btn-glass">
            <ChevronLeft size={14} /> Retour au projet
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in pb-16">
      <div>
        <Link href={`/projects/${slug}`} className="mono-sm inline-flex items-center gap-1 hover:opacity-100 opacity-70">
          <ChevronLeft size={12} /> Retour au projet
        </Link>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono-sm mb-2">Editor · Remotion</div>
          <h1 className="heading-xl">{data.project.label}</h1>
          <p className="text-[13px] mt-2" style={{ color: "var(--text-secondary)" }}>
            {data.meta.clipCount} clips · {data.meta.totalSeconds.toFixed(1)}s @ {data.meta.fps}fps
            {data.meta.missingClips > 0 && (
              <span style={{ color: "var(--orange)" }}> · {data.meta.missingClips} scène(s) sans clip ignorée(s)</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={exportFcpxml}
            disabled={composition.clips.length === 0}
            className="btn-glass"
            style={{ opacity: composition.clips.length === 0 ? 0.5 : 1 }}
            title="Exporter en FCPXML (DaVinci Resolve / Premiere / Final Cut)"
          >
            <FileDown size={14} />
            <span className="text-[12px]">Export FCPXML</span>
          </button>
          <button
            onClick={startRender}
            disabled={renderState.phase === "running" || composition.clips.length === 0}
            className="btn-primary"
            style={{ padding: "11px 18px", opacity: composition.clips.length === 0 ? 0.5 : 1 }}
          >
            {renderState.phase === "running" ? <><Loader2 size={14} className="animate-spin" /> Render en cours…</> : <><Film size={14} /> Render mp4</>}
          </button>
        </div>
      </header>

      {/* Player */}
      <div className="glass-static p-4">
        {composition.clips.length === 0 ? (
          <div className="aspect-video flex items-center justify-center mono-sm" style={{ background: "var(--bg-glass-hover)", borderRadius: "var(--radius-sm)" }}>
            Aucun clip disponible — génère les scènes du projet d&apos;abord.
          </div>
        ) : (
          <Player
            ref={playerRef}
            component={MontageComposition as unknown as ComponentType<Record<string, unknown>>}
            inputProps={composition as unknown as Record<string, unknown>}
            durationInFrames={durationInFrames}
            fps={FPS}
            compositionWidth={WIDTH}
            compositionHeight={HEIGHT}
            style={{ width: "100%", borderRadius: "var(--radius-sm)" }}
            controls
            loop
            acknowledgeRemotionLicense
          />
        )}
      </div>

      {composition.clips.length > 0 && (
        <>
          <div className="glass-static p-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={splitAtPlayhead}
              className="btn-glass"
              title="Split at playhead (S)"
            >
              <Scissors size={13} />
              <span className="text-[12px]">Split</span>
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={selectedIds.size === 0}
              className="btn-glass"
              title="Supprimer la sélection (Suppr)"
              style={{ opacity: selectedIds.size === 0 ? 0.5 : 1 }}
            >
              <Trash2 size={13} />
              <span className="text-[12px]">Supprimer ({selectedIds.size})</span>
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={resetComposition}
              className="btn-glass"
              title="Réinitialiser au montage d'origine"
            >
              <RotateCcw size={13} />
              <span className="text-[12px]">Reset</span>
            </button>
          </div>
          <RemotionTimeline
            clips={composition.clips}
            onClipsChange={setClips}
            fps={FPS}
            durationInFrames={durationInFrames}
            playerRef={playerRef}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onClipOpen={setModalClipId}
            voiceoverUrl={composition.voiceoverUrl}
            musicUrl={composition.musicUrl}
          />
        </>
      )}

      {modalClipId && composition && (() => {
        const found = composition.clips.find((c) => c.id === modalClipId);
        if (!found) return null;
        return (
          <SceneModal
            clip={found}
            slug={slug}
            fps={FPS}
            onClose={() => setModalClipId(null)}
            onClipUpdated={(updated) => {
              setComposition((prev) => prev ? {
                ...prev,
                clips: prev.clips.map((c) => c.id === updated.id ? updated : c),
              } : prev);
            }}
          />
        );
      })()}

      {/* Controls */}
      <div className="glass-static p-5 space-y-4">
        <h2 className="heading-md text-[14px]">Audio</h2>
        <div className="grid gap-3">
          <button
            type="button"
            onClick={() => setProp("keepClipAudio", !composition.keepClipAudio)}
            className="flex items-start gap-3 p-3 text-left transition-all w-full"
            style={{
              background: composition.keepClipAudio ? "var(--accent-bg)" : "var(--bg-glass)",
              border: `1.5px solid ${composition.keepClipAudio ? "var(--accent)" : "var(--border-glass)"}`,
              borderRadius: "var(--radius-sm)",
            }}
          >
            {composition.keepClipAudio ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold">Garder l&apos;audio des clips</div>
              <div className="text-[11px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                Dialogues + ambiance générés par Veo3. Désactive si tu utilises une voix off externe.
              </div>
            </div>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="mono-sm">Voiceover URL (optionnel)</label>
            <input
              type="text"
              value={composition.voiceoverUrl ?? ""}
              onChange={(e) => setProp("voiceoverUrl", e.target.value || undefined)}
              placeholder="/generated/.../voiceover.mp3"
              className="w-full px-3 py-2 text-[13px] outline-none font-mono"
              style={{
                background: "var(--bg-glass-hover)",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
              }}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <label className="mono-sm">Volume voix off · {composition.voiceoverVolume.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={composition.voiceoverVolume}
              onChange={(e) => setProp("voiceoverVolume", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div className="space-y-1.5">
            <label className="mono-sm">Musique URL (optionnel)</label>
            <input
              type="text"
              value={composition.musicUrl ?? ""}
              onChange={(e) => setProp("musicUrl", e.target.value || undefined)}
              placeholder="/generated/.../music.mp3"
              className="w-full px-3 py-2 text-[13px] outline-none font-mono"
              style={{
                background: "var(--bg-glass-hover)",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
              }}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <label className="mono-sm">Volume musique · {composition.musicVolume.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={composition.musicVolume}
              onChange={(e) => setProp("musicVolume", parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
      </div>

      {/* Clip list */}
      <div className="glass-static p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="heading-md text-[14px]">Clips · {composition.clips.length}</h2>
          <button
            onClick={() => {
              setLoading(true);
              fetch(`/api/projects/${slug}/remotion-data`).then(async (r) => {
                const d = (await r.json()) as RemotionDataResponse;
                setData(d);
                setComposition(d.composition);
              }).finally(() => setLoading(false));
            }}
            className="btn-glass"
          >
            <RefreshCw size={12} /> Recharger
          </button>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          {composition.clips.map((c, i) => (
            <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-[12px]" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", borderRadius: "var(--radius-sm)" }}>
              <span className="mono-sm flex-shrink-0">{String(i + 1).padStart(2, "0")}</span>
              <span className="flex-1 truncate">{c.label ?? c.url}</span>
              <span className="mono-sm flex-shrink-0">{(effectiveLength(c) / FPS).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      </div>

      {/* Render result */}
      {renderState.phase === "running" && (
        <div className="glass-static p-4 flex items-center gap-3">
          <Loader2 size={16} className="animate-spin text-blue-400" />
          <div className="flex-1">
            <div className="text-[13px] font-medium">Render en cours…</div>
            <div className="mono-sm">{renderState.message}</div>
          </div>
        </div>
      )}
      {renderState.phase === "done" && (
        <div className="glass-static p-4 flex items-center gap-3">
          <Play size={16} style={{ color: "var(--green)" }} />
          <div className="flex-1">
            <div className="text-[13px] font-medium">Render terminé</div>
            <div className="mono-sm">{renderState.outputUrl}</div>
          </div>
          <a href={renderState.outputUrl} target="_blank" rel="noreferrer" className="btn-primary">
            <Film size={14} /> Ouvrir
          </a>
        </div>
      )}
      {renderState.phase === "error" && (
        <div className="px-4 py-3 rounded-lg text-[13px]" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
          {renderState.message}
        </div>
      )}
    </div>
  );
}

// ---- localStorage persistence -------------------------------------------
// Bump the version suffix any time the RemotionClip / MontageCompositionProps
// schema changes so old stored compositions don't crash the renderer.
const STORAGE_SCHEMA_VERSION = 2;
function storageKey(slug: string): string {
  return `ff_remotion_composition_v${STORAGE_SCHEMA_VERSION}:${slug}`;
}
function readStoredComposition(slug: string): MontageCompositionProps | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MontageCompositionProps;
    if (!parsed || !Array.isArray(parsed.clips)) return null;
    // Schema sanity check — older stored versions lacked startFrame / trackIndex
    // (we shifted from sequential to absolute positioning). Drop the stored
    // copy and let the page fall back to the server composition.
    const valid = parsed.clips.every((c) => typeof c.startFrame === "number" && typeof c.trackIndex === "number" && typeof c.id === "string");
    if (!valid) {
      window.localStorage.removeItem(storageKey(slug));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function writeStoredComposition(slug: string, comp: MontageCompositionProps): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(slug), JSON.stringify(comp));
  } catch {
    /* quota exceeded or storage disabled — silently drop */
  }
}
function clearStoredComposition(slug: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(storageKey(slug)); } catch {}
}
