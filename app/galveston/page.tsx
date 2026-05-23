"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Square, ImageIcon, Film, RefreshCw, Loader2,
  CheckCircle2, AlertTriangle, Clock, Wrench, Filter,
  ChevronDown, ChevronUp, Eye, Wand2,
} from "lucide-react";

interface SceneView {
  id: number;
  section: string;
  image_prompt: string;
  animation_prompt: string;
  imageUrl?: string;
  videoUrl?: string;
  imageAttempt?: number;
  videoAttempt?: number;
  imageQAFailed?: boolean;
  imageStuck?: boolean;
  videoStuck?: boolean;
  imageFailed?: boolean;
  videoFailed?: boolean;
  imageProcessing?: boolean;
  videoProcessing?: boolean;
  imageError?: string;
  videoError?: string;
  status: string;
}
interface ActiveRun {
  id: string;
  mode: string;
  ids?: number[];
  startedAt: number;
  status: string;
  log: string[];
}
interface Counts { total: number; images_done: number; videos_done: number; image_pending: number; video_pending: number; failed: number; stuck: number; qa_failed: number; }
interface State { project: string; scenes: SceneView[]; activeRun: ActiveRun | null; recentRuns: ActiveRun[]; counts: Counts; }

type RunMode = "rolling" | "images-only" | "videos-only" | "resume" | "failed-only" | "stuck-only";

const MODE_LABELS: Record<RunMode, string> = {
  "rolling": "Rolling pipeline",
  "images-only": "Images seules",
  "videos-only": "Vidéos seules",
  "resume": "Reprendre tasks",
  "failed-only": "Failed only",
  "stuck-only": "Stuck only",
};

type Filter = "all" | "todo" | "done" | "failed" | "stuck" | "qa";

const FILTER_LABELS: Record<Filter, string> = {
  all: "Toutes",
  todo: "À faire",
  done: "Terminées",
  failed: "Failed",
  stuck: "Stuck",
  qa: "QA fail",
};

export default function GalvestonPage() {
  const [state, setState] = useState<State | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedScene, setExpandedScene] = useState<number | null>(null);
  const [showLog, setShowLog] = useState(true);
  const [pending, setPending] = useState<{ scene?: number; action?: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Fetch state on interval
  useEffect(() => {
    let stop = false;
    const fetchState = async () => {
      try {
        const res = await fetch("/api/galveston/state", { cache: "no-store" });
        const data = await res.json();
        if (!stop) setState(data);
      } catch {}
    };
    fetchState();
    const interval = setInterval(fetchState, 2500);
    return () => { stop = true; clearInterval(interval); };
  }, []);

  // Auto-scroll log when active run output grows
  const activeLogLen = state?.activeRun?.log.length ?? 0;
  useEffect(() => {
    if (logEndRef.current && state?.activeRun) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [activeLogLen, state?.activeRun]);

  const filteredScenes = useMemo(() => {
    if (!state) return [];
    return state.scenes.filter((s) => {
      switch (filter) {
        case "all": return true;
        case "done": return s.status === "completed";
        case "todo": return s.status !== "completed" && !s.imageFailed && !s.videoFailed && !s.imageStuck && !s.videoStuck && !s.imageQAFailed;
        case "failed": return s.imageFailed || s.videoFailed;
        case "stuck": return s.imageStuck || s.videoStuck;
        case "qa": return s.imageQAFailed;
        default: return true;
      }
    });
  }, [state, filter]);

  const startRun = async (mode: RunMode) => {
    try {
      const res = await fetch("/api/galveston/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", mode }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Erreur lors du lancement");
      }
    } catch (e) { alert(String(e)); }
  };
  const stopRun = async () => {
    try {
      await fetch("/api/galveston/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
    } catch {}
  };
  const sceneAction = async (id: number, action: "regen-image" | "regen-video" | "generate-video") => {
    setPending({ scene: id, action });
    try {
      const res = await fetch("/api/galveston/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Erreur");
      }
    } catch (e) { alert(String(e)); }
    finally { setTimeout(() => setPending(null), 800); }
  };

  if (!state) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
      </div>
    );
  }

  const c = state.counts;
  const completion = c.total > 0 ? Math.round((c.videos_done / c.total) * 100) : 0;
  const activeRun = state.activeRun;
  const activeMs = activeRun ? Date.now() - activeRun.startedAt : 0;

  return (
    <div className="flex flex-col gap-10">
      {/* Hero */}
      <div className="flex flex-col gap-1">
        <span className="mono-sm">Workspace / Project</span>
        <h1 className="heading-xl mt-2">Galveston 1900</h1>
        <p className="text-[15px] max-w-md mt-1" style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Documentary cinematic — {c.total} scènes. Pipeline image → vidéo via GenAIPro Veo V2.
        </p>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <Stat value={`${c.images_done}/${c.total}`} label="Images" tone={c.images_done === c.total ? "green" : undefined} />
        <Divider />
        <Stat value={`${c.videos_done}/${c.total}`} label="Vidéos" tone={c.videos_done === c.total ? "green" : undefined} />
        <Divider />
        <Stat value={`${completion}%`} label="Complétion" />
        <Divider />
        <Stat value={String(c.failed)} label="Failed" tone={c.failed > 0 ? "red" : undefined} />
        <Stat value={String(c.stuck)} label="Stuck" tone={c.stuck > 0 ? "orange" : undefined} />
        <Stat value={String(c.qa_failed)} label="QA fail" tone={c.qa_failed > 0 ? "orange" : undefined} />
      </div>

      {/* Progress bar */}
      <div className="progress-bar" style={{ height: 4 }}>
        <div className="progress-fill" style={{ width: `${completion}%` }} />
      </div>

      {/* Run controls */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="heading-md">Pipeline</h2>
          {activeRun && (
            <span className="badge badge-blue">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              {MODE_LABELS[activeRun.mode as RunMode] ?? activeRun.mode} · {Math.floor(activeMs / 1000)}s
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {!activeRun ? (
            <>
              <button className="btn-primary" onClick={() => startRun("rolling")}>
                <Play size={14} /> Lancer rolling pipeline
              </button>
              <button className="btn-glass" onClick={() => startRun("images-only")}>
                <ImageIcon size={13} /> Images seules
              </button>
              <button className="btn-glass" onClick={() => startRun("videos-only")}>
                <Film size={13} /> Vidéos seules
              </button>
              <button className="btn-glass" onClick={() => startRun("resume")}>
                <RefreshCw size={13} /> Reprendre
              </button>
              {c.failed > 0 && (
                <button className="btn-glass" onClick={() => startRun("failed-only")}>
                  <AlertTriangle size={13} /> Failed only ({c.failed})
                </button>
              )}
              {c.stuck > 0 && (
                <button className="btn-glass" onClick={() => startRun("stuck-only")}>
                  <Clock size={13} /> Stuck only ({c.stuck})
                </button>
              )}
            </>
          ) : (
            <button
              className="btn-primary"
              style={{ background: "var(--red)" }}
              onClick={stopRun}
            >
              <Square size={14} /> Stop
            </button>
          )}
        </div>
      </div>

      {/* Live log */}
      {activeRun && (
        <div className="glass-static animate-in" style={{ borderRadius: "var(--radius-md)" }}>
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border-glass)" }}>
            <div className="flex items-center gap-3">
              <Loader2 size={14} className="animate-spin" style={{ color: "var(--accent)" }} />
              <span className="heading-md">Live log</span>
              <span className="mono-sm">{activeRun.log.length} lines</span>
            </div>
            <button className="btn-glass" onClick={() => setShowLog((v) => !v)}>
              {showLog ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {showLog ? "Masquer" : "Afficher"}
            </button>
          </div>
          {showLog && (
            <div
              className="px-5 py-3 font-mono text-[11px] overflow-y-auto"
              style={{
                color: "var(--text-secondary)",
                maxHeight: 280,
                background: "var(--bg-glass)",
                borderRadius: "0 0 var(--radius-md) var(--radius-md)",
              }}
            >
              {activeRun.log.length === 0 ? (
                <span style={{ color: "var(--text-tertiary)" }}>(en attente du premier output...)</span>
              ) : (
                activeRun.log.slice(-100).map((line, i) => (
                  <div key={i} style={{ whiteSpace: "pre-wrap", color: line.startsWith("[err]") ? "var(--red)" : line.match(/(FAIL|STUCK|ERROR)/) ? "var(--orange)" : line.match(/^OK /) ? "var(--green)" : undefined }}>
                    {line}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter size={13} style={{ color: "var(--text-tertiary)" }} />
        {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => {
          const isActive = filter === f;
          const counts: Record<Filter, number> = {
            all: c.total,
            todo: c.total - c.videos_done - c.failed - c.stuck - c.qa_failed,
            done: c.videos_done,
            failed: c.failed,
            stuck: c.stuck,
            qa: c.qa_failed,
          };
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="filter-chip"
              style={{
                padding: "5px 12px",
                borderRadius: 100,
                border: isActive ? "1px solid var(--accent)" : "1px solid var(--border-glass)",
                background: isActive ? "var(--accent-bg)" : "transparent",
                color: isActive ? "var(--accent)" : "var(--text-secondary)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s",
                fontFamily: "var(--font-sans)",
              }}
            >
              {FILTER_LABELS[f]} <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts[f]}</span>
            </button>
          );
        })}
      </div>

      {/* Scenes grid */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
        {filteredScenes.map((s) => (
          <SceneCard
            key={s.id}
            scene={s}
            expanded={expandedScene === s.id}
            onExpand={() => setExpandedScene(expandedScene === s.id ? null : s.id)}
            onRegenImage={() => sceneAction(s.id, "regen-image")}
            onRegenVideo={() => sceneAction(s.id, "regen-video")}
            onGenerateVideo={() => sceneAction(s.id, "generate-video")}
            isPending={pending?.scene === s.id}
            disabled={!!activeRun && activeRun.mode !== "scene-regen-image" && activeRun.mode !== "scene-regen-video" && activeRun.mode !== "scene-generate-video"}
          />
        ))}
        {filteredScenes.length === 0 && (
          <div
            className="col-span-full flex flex-col items-center justify-center rounded-2xl py-16 gap-3"
            style={{ border: "1px dashed var(--border-glass)" }}
          >
            <Filter size={20} style={{ color: "var(--text-tertiary)" }} />
            <p className="text-[13px]" style={{ color: "var(--text-tertiary)" }}>
              Aucune scène dans ce filtre
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: "green" | "red" | "orange" }) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "orange" ? "var(--orange)" : undefined;
  return (
    <div>
      <span className="stat-value" style={color ? { color } : undefined}>{value}</span>
      <span className="stat-label ml-2">{label}</span>
    </div>
  );
}
function Divider() {
  return <div className="w-px h-8" style={{ background: "var(--border-glass)" }} />;
}

function SceneCard({
  scene, expanded, onExpand, onRegenImage, onRegenVideo, onGenerateVideo, isPending, disabled,
}: {
  scene: SceneView;
  expanded: boolean;
  onExpand: () => void;
  onRegenImage: () => void;
  onRegenVideo: () => void;
  onGenerateVideo: () => void;
  isPending: boolean;
  disabled: boolean;
}) {
  const statusBadge = (() => {
    switch (scene.status) {
      case "completed": return <span className="badge badge-green"><CheckCircle2 size={10} /> Complète</span>;
      case "video-pending": return <span className="badge badge-blue"><Loader2 size={10} className="animate-spin" /> Vidéo en cours</span>;
      case "image-pending": return <span className="badge badge-blue"><Loader2 size={10} className="animate-spin" /> Image en cours</span>;
      case "image-ok-no-video": return <span className="badge badge-accent"><Wand2 size={10} /> Prête à animer</span>;
      case "image-qa-failed": return <span className="badge badge-orange"><AlertTriangle size={10} /> QA fail</span>;
      case "image-failed": case "video-failed": return <span className="badge badge-red"><AlertTriangle size={10} /> Failed</span>;
      case "image-stuck": case "video-stuck": return <span className="badge badge-orange"><Clock size={10} /> Stuck</span>;
      default: return <span className="badge badge-gray">À générer</span>;
    }
  })();

  return (
    <div
      className="glass-static animate-in"
      style={{
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Media row */}
      <div className="grid grid-cols-2 gap-px" style={{ background: "var(--border-glass)", aspectRatio: "16/4.5" }}>
        <MediaBox kind="image" url={scene.imageUrl} processing={scene.imageProcessing} failed={scene.imageFailed} stuck={scene.imageStuck} qa={scene.imageQAFailed} />
        <MediaBox kind="video" url={scene.videoUrl} processing={scene.videoProcessing} failed={scene.videoFailed} stuck={scene.videoStuck} />
      </div>

      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>#{String(scene.id).padStart(2, "0")}</span>
          <span className="text-[13px] font-medium truncate" style={{ color: "var(--text-primary)" }}>{scene.section.replace(/_/g, " ")}</span>
        </div>
        {statusBadge}
      </div>

      {/* Action row */}
      <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
        <button
          className="btn-glass"
          onClick={onRegenImage}
          disabled={disabled || isPending}
          style={{ opacity: disabled || isPending ? 0.4 : 1 }}
          title="Regénérer l'image"
        >
          <ImageIcon size={11} /> Regen img
          {scene.imageAttempt && scene.imageAttempt > 1 ? <span className="mono-sm ml-1">×{scene.imageAttempt}</span> : null}
        </button>
        {scene.imageUrl && !scene.videoUrl && (
          <button
            className="btn-glass"
            onClick={onGenerateVideo}
            disabled={disabled || isPending}
            style={{ opacity: disabled || isPending ? 0.4 : 1, color: "var(--accent)", borderColor: "var(--accent)" }}
            title="Lancer l'animation"
          >
            <Wand2 size={11} /> Animer
          </button>
        )}
        {scene.videoUrl && (
          <button
            className="btn-glass"
            onClick={onRegenVideo}
            disabled={disabled || isPending}
            style={{ opacity: disabled || isPending ? 0.4 : 1 }}
            title="Regénérer la vidéo"
          >
            <Film size={11} /> Regen vid
            {scene.videoAttempt && scene.videoAttempt > 1 ? <span className="mono-sm ml-1">×{scene.videoAttempt}</span> : null}
          </button>
        )}
        <div className="ml-auto">
          <button
            className="btn-glass"
            onClick={onExpand}
            style={{ padding: "5px 8px" }}
            title={expanded ? "Masquer" : "Voir prompts"}
          >
            <Eye size={11} /> {expanded ? "Masquer" : "Détail"}
          </button>
        </div>
      </div>

      {/* Expanded prompts */}
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 animate-in" style={{ borderTop: "1px solid var(--border-glass)", paddingTop: 12 }}>
          <PromptBlock label="Image prompt" text={scene.image_prompt} />
          <PromptBlock label="Animation prompt" text={scene.animation_prompt} />
          {(scene.imageError || scene.videoError) && (
            <div className="px-3 py-2 rounded-lg" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
              <div className="mono-sm" style={{ color: "var(--red)" }}>Erreur</div>
              <div className="text-[12px] mt-0.5">{scene.imageError || scene.videoError}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MediaBox({ kind, url, processing, failed, stuck, qa }: { kind: "image" | "video"; url?: string; processing?: boolean; failed?: boolean; stuck?: boolean; qa?: boolean }) {
  const placeholder = (icon: React.ReactNode, text: string, color?: string) => (
    <div className="flex flex-col items-center justify-center gap-1.5" style={{ background: "var(--bg-glass)", color: color ?? "var(--text-tertiary)" }}>
      {icon}
      <span className="mono-sm" style={{ color: color ?? "var(--text-tertiary)" }}>{text}</span>
    </div>
  );

  if (url) {
    if (kind === "image") {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      );
    }
    return (
      <video
        src={url}
        muted
        loop
        playsInline
        autoPlay
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000" }}
      />
    );
  }

  if (processing) return placeholder(<Loader2 size={20} className="animate-spin" style={{ color: "var(--accent)" }} />, kind === "image" ? "image…" : "vidéo…", "var(--accent)");
  if (failed) return placeholder(<AlertTriangle size={20} style={{ color: "var(--red)" }} />, "failed", "var(--red)");
  if (stuck) return placeholder(<Clock size={20} style={{ color: "var(--orange)" }} />, "stuck", "var(--orange)");
  if (qa && kind === "image") return placeholder(<AlertTriangle size={20} style={{ color: "var(--orange)" }} />, "QA fail", "var(--orange)");
  return placeholder(kind === "image" ? <ImageIcon size={20} /> : <Film size={20} />, kind === "image" ? "no image" : "no video");
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mono-sm mb-1">{label}</div>
      <div className="text-[12px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>{text}</div>
    </div>
  );
}
