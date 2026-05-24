"use client";

import { useMemo, useState } from "react";
import type { Scene } from "@/lib/projects/types";
import { SceneCard } from "./SceneCard";

type Filter = "all" | "done" | "image-only" | "pending" | "failed" | "stuck" | "not-started";

interface Props {
  scenes: Scene[];
  onSceneClick: (scene: Scene) => void;
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

export function ScenesGrid({ scenes, onSceneClick }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

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

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {filtered.map((scene) => (
          <SceneCard key={scene.id} scene={scene} onClick={() => onSceneClick(scene)} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="glass-static py-16 text-center" style={{ color: "var(--text-tertiary)" }}>
          Aucune scène correspondante.
        </div>
      )}
    </div>
  );
}
