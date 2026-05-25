"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { CheckSquare, X, ImageIcon, ScanEye } from "lucide-react";
import type { Scene } from "@/lib/projects/types";
import { SceneCard } from "./SceneCard";
import { BatchRegenModal } from "./BatchRegenModal";

interface SceneFlag { severity: "minor" | "bad"; issues: string[] }
interface AnalysisState {
  status: "running" | "done" | "error" | "none";
  total?: number;
  done?: number;
  flagged?: Array<{ id: number; severity: "minor" | "bad"; issues: string[] }>;
}

type Filter = "all" | "done" | "image-only" | "pending" | "failed" | "stuck" | "not-started";

interface Props {
  scenes: Scene[];
  onSceneClick: (scene: Scene) => void;
  slug: string;
  onAction: () => void;
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Toutes" },
  { value: "done", label: "OK" },
  { value: "image-only", label: "Image OK" },
  { value: "pending", label: "En cours" },
  { value: "failed", label: "Échec" },
  { value: "stuck", label: "Stuck" },
  { value: "not-started", label: "Non lancé" },
];

export function ScenesGrid({ scenes, onSceneClick, slug, onAction }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "none" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load any existing analysis on mount + poll while one is running.
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/projects/${slug}/analyze-images`);
        const d = (await r.json()) as AnalysisState;
        if (!cancelled) setAnalysis(d);
        if (d.status !== "running" && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch { /* ignore */ }
    };
    fetchOnce();
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const flagById = useMemo(() => {
    const m = new Map<number, SceneFlag>();
    for (const f of analysis.flagged ?? []) m.set(f.id, { severity: f.severity, issues: f.issues });
    return m;
  }, [analysis]);

  const startAnalysis = async () => {
    try {
      const r = await fetch(`/api/projects/${slug}/analyze-images`, { method: "POST" });
      const d = await r.json();
      if (r.ok || r.status === 409) {
        setAnalysis(d.state ?? { status: "running", done: 0, total: 0, flagged: [] });
        if (!pollRef.current) {
          pollRef.current = setInterval(async () => {
            const rr = await fetch(`/api/projects/${slug}/analyze-images`);
            const dd = (await rr.json()) as AnalysisState;
            setAnalysis(dd);
            if (dd.status !== "running" && pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }, 5000);
        }
      }
    } catch { /* ignore */ }
  };

  const selectFlagged = () => {
    const ids = (analysis.flagged ?? []).map((f) => f.id);
    if (ids.length === 0) return;
    setSelectMode(true);
    setSelected(new Set(ids));
  };

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: scenes.length, done: 0, "image-only": 0, pending: 0, failed: 0, stuck: 0, "not-started": 0 };
    for (const s of scenes) {
      if (s.status === "done") c.done++;
      else if (s.status === "image-only") c["image-only"]++;
      else if (s.status === "video-pending" || s.status === "image-pending") c.pending++;
      else if (s.status === "video-failed" || s.status === "image-failed") c.failed++;
      else if (s.status === "video-stuck" || s.status === "image-stuck") c.stuck++;
      else c["not-started"]++;
    }
    return c;
  }, [scenes]);

  const filtered = useMemo(() => {
    let arr = scenes;
    if (filter !== "all") {
      arr = arr.filter((s) => {
        if (filter === "done") return s.status === "done";
        if (filter === "image-only") return s.status === "image-only";
        if (filter === "pending") return s.status === "video-pending" || s.status === "image-pending";
        if (filter === "failed") return s.status === "video-failed" || s.status === "image-failed";
        if (filter === "stuck") return s.status === "video-stuck" || s.status === "image-stuck";
        if (filter === "not-started") return s.status === "not-started";
        return true;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter((s) =>
        String(s.id).includes(q) ||
        (s.title?.toLowerCase().includes(q) ?? false) ||
        (s.section?.toLowerCase().includes(q) ?? false) ||
        (s.vo?.toLowerCase().includes(q) ?? false)
      );
    }
    return arr;
  }, [scenes, filter, search]);

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  // Select-all targets only the currently filtered/searched scenes — matches
  // what the user actually sees, so "Échec" filter + select-all = retry all fails.
  const selectAllFiltered = () => {
    setSelected(new Set(filtered.map((s) => s.id)));
  };

  const selectedScenes = useMemo(
    () => scenes.filter((s) => selected.has(s.id)),
    [scenes, selected],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={filter === f.value ? "btn-primary" : "btn-glass"}
            style={{ padding: "5px 12px", fontSize: 12 }}
          >
            {f.label}
            <span className={filter === f.value ? "" : ""} style={{ opacity: 0.7, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
              {counts[f.value]}
            </span>
          </button>
        ))}
        <div className="flex-1" />
        {!selectMode && (
          <>
            <button
              onClick={startAnalysis}
              disabled={analysis.status === "running"}
              className="btn-glass flex-shrink-0"
              style={{ padding: "5px 12px", fontSize: 12, opacity: analysis.status === "running" ? 0.6 : 1 }}
              title="Analyse toutes les images avec Claude Vision et flague les ratées (mains, texte, artefacts…). Long : ~15-25s/image, en arrière-plan."
            >
              <ScanEye size={14} />
              {analysis.status === "running"
                ? `Analyse ${analysis.done ?? 0}/${analysis.total ?? "?"}…`
                : "Analyser (Vision)"}
            </button>
            {(analysis.flagged?.length ?? 0) > 0 && (
              <button
                onClick={selectFlagged}
                className="btn-glass flex-shrink-0"
                style={{ padding: "5px 12px", fontSize: 12, color: "var(--red)" }}
                title="Sélectionne les images flaggées par l'analyse pour les régénérer en lot"
              >
                <X size={14} />
                Ratées ({analysis.flagged?.length})
              </button>
            )}
            {analysis.status === "done" && (analysis.flagged?.length ?? 0) === 0 && (
              <span className="mono-sm flex-shrink-0" style={{ color: "var(--green)", fontSize: 12 }}>
                ✓ aucune ratée
              </span>
            )}
            <button
              onClick={() => setSelectMode(true)}
              className="btn-glass flex-shrink-0"
              style={{ padding: "5px 12px", fontSize: 12 }}
              title="Sélectionner plusieurs scènes pour régénérer leurs images en lot"
            >
              <CheckSquare size={14} />
              Sélectionner
            </button>
          </>
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filtrer (id, titre, vo)…"
          className="px-3 py-1.5 text-[13px] outline-none"
          style={{
            background: "var(--bg-glass-hover)",
            border: "1px solid var(--border-glass)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            minWidth: 220,
          }}
        />
      </div>

      {/* Selection action bar */}
      {selectMode && (
        <div
          className="glass-static flex flex-wrap items-center gap-2 px-3 py-2.5"
          style={{ borderRadius: "var(--radius-sm)" }}
        >
          <span className="mono-sm" style={{ minWidth: 90 }}>
            {selected.size} sélectionnée{selected.size > 1 ? "s" : ""}
          </span>
          <button onClick={selectAllFiltered} className="btn-glass" style={{ padding: "4px 10px", fontSize: 12 }}>
            Tout ({filtered.length})
          </button>
          <button onClick={() => setSelected(new Set())} disabled={selected.size === 0} className="btn-glass" style={{ padding: "4px 10px", fontSize: 12, opacity: selected.size === 0 ? 0.5 : 1 }}>
            Désélectionner
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setModalOpen(true)}
            disabled={selected.size === 0}
            className="btn-primary"
            style={{ padding: "5px 14px", fontSize: 12, opacity: selected.size === 0 ? 0.5 : 1 }}
          >
            <ImageIcon size={14} />
            {`Regen ${selected.size || ""} image${selected.size > 1 ? "s" : ""}`}
          </button>
          <button onClick={exitSelectMode} className="btn-glass" style={{ padding: "5px 10px", fontSize: 12 }}>
            <X size={14} />
            Annuler
          </button>
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {filtered.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            selectable={selectMode}
            selected={selected.has(scene.id)}
            flag={flagById.get(scene.id)}
            onClick={() => (selectMode ? toggleSelect(scene.id) : onSceneClick(scene))}
          />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="glass-static py-16 text-center" style={{ color: "var(--text-tertiary)" }}>
          Aucune scène correspondante.
        </div>
      )}

      {modalOpen && (
        <BatchRegenModal
          slug={slug}
          scenes={selectedScenes}
          onClose={() => setModalOpen(false)}
          onDone={onAction}
        />
      )}
    </div>
  );
}
