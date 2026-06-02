"use client";

import Link from "next/link";
import { Film, ChevronRight } from "lucide-react";
import type { ProjectSummary, RunInfo } from "@/lib/projects/types";

type Row = ProjectSummary & { activeRun?: RunInfo | null };

// Grid template shared by header + rows so columns stay aligned.
const COLS = "minmax(180px,1fr) 130px 110px 70px minmax(160px,200px) 80px 24px";

function Ratio({ have, total }: { have: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((have / total) * 100)) : 0;
  const complete = total > 0 && have >= total;
  const color = complete ? "var(--green)" : have === 0 ? "var(--text-tertiary)" : "var(--accent)";
  return (
    <div className="flex flex-col gap-1">
      <span className="mono-sm" style={{ color }}>
        {have}<span style={{ color: "var(--text-tertiary)" }}> / {total}</span>
      </span>
      <div className="progress-bar" style={{ height: 3 }}>
        <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function ProjectTable({ projects }: { projects: Row[] }) {
  // Most images first, descending. Tie-break on scenes done then label.
  const sorted = [...projects].sort(
    (a, b) => b.imagesCount - a.imagesCount || b.doneCount - a.doneCount || a.label.localeCompare(b.label),
  );
  return (
    <div className="glass-static overflow-hidden" style={{ padding: 0 }}>
      {/* Header */}
      <div
        className="grid items-center gap-3 px-4 py-2.5 mono-sm"
        style={{
          gridTemplateColumns: COLS,
          borderBottom: "1px solid var(--border-glass)",
          color: "var(--text-tertiary)",
          background: "var(--bg-glass)",
        }}
      >
        <div>Projet</div>
        <div>Images</div>
        <div>Scènes faites</div>
        <div>Clips</div>
        <div>État</div>
        <div>Master</div>
        <div />
      </div>

      {/* Rows */}
      {sorted.map((p) => {
        const total = p.totalScenes;
        return (
          <Link
            key={p.slug}
            href={`/projects/${p.slug}`}
            className="grid items-center gap-3 px-4 py-3 group transition-colors"
            style={{
              gridTemplateColumns: COLS,
              borderBottom: "1px solid var(--border-glass)",
            }}
          >
            {/* Projet */}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {p.activeRun && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0" style={{ background: "var(--green)" }} />
                )}
                <span className="text-[13px] font-medium truncate" style={{ color: "var(--text-primary)" }}>
                  {p.label}
                </span>
              </div>
              <div className="mono-sm truncate" style={{ color: "var(--text-tertiary)" }}>{p.slug}</div>
            </div>

            {/* Images / total scenes */}
            <div>{total > 0 ? <Ratio have={p.imagesCount} total={total} /> : <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>—</span>}</div>

            {/* Scenes done / total */}
            <div>{total > 0 ? <Ratio have={p.doneCount} total={total} /> : <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>—</span>}</div>

            {/* Clips */}
            <div className="mono-sm" style={{ color: p.clipsCount > 0 ? "var(--text-secondary)" : "var(--text-tertiary)" }}>
              {p.clipsCount > 0 ? p.clipsCount : "—"}
            </div>

            {/* État badges */}
            <div className="flex flex-wrap gap-1">
              {p.pendingCount > 0 && <span className="badge badge-blue">{p.pendingCount} en cours</span>}
              {p.failedCount > 0 && <span className="badge badge-red">{p.failedCount} fail</span>}
              {p.stuckCount > 0 && <span className="badge badge-orange">{p.stuckCount} stuck</span>}
              {p.pendingCount === 0 && p.failedCount === 0 && p.stuckCount === 0 && total > 0 && p.doneCount >= total && (
                <span className="badge badge-accent">ok</span>
              )}
              {total === 0 && <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>{p.script ? "pas de prompts" : "pas de script"}</span>}
            </div>

            {/* Master */}
            <div>
              {p.masterUrl ? (
                <span className="badge badge-accent"><Film size={10} style={{ marginRight: 3 }} />oui</span>
              ) : (
                <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>—</span>
              )}
            </div>

            <ChevronRight size={16} className="opacity-20 group-hover:opacity-100 transition justify-self-end" />
          </Link>
        );
      })}
    </div>
  );
}
