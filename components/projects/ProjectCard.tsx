"use client";

import Link from "next/link";
import { ChevronRight, Film } from "lucide-react";
import type { ProjectSummary, RunInfo } from "@/lib/projects/types";

interface Props {
  project: ProjectSummary & { activeRun?: RunInfo | null };
}

export function ProjectCard({ project }: Props) {
  const total = project.totalScenes;
  const done = project.doneCount;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const hasRun = !!project.activeRun;

  return (
    <Link
      href={`/projects/${project.slug}`}
      className="glass block p-5 group cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="heading-md truncate">{project.label}</h3>
            {hasRun && (
              <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--green)" }} />
            )}
          </div>
          {project.description && (
            <p className="text-[13px] line-clamp-2" style={{ color: "var(--text-secondary)" }}>
              {project.description}
            </p>
          )}
        </div>
        <ChevronRight size={18} className="opacity-30 group-hover:opacity-100 transition flex-shrink-0" />
      </div>

      {total > 0 ? (
        <>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="stat-value text-[28px]">{done}</span>
            <span className="text-[14px]" style={{ color: "var(--text-tertiary)" }}>/ {total}</span>
            <span className="ml-auto mono-sm">{percent}%</span>
          </div>
          <div className="progress-bar mb-3">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {project.pendingCount > 0 && <span className="badge badge-blue">{project.pendingCount} en cours</span>}
            {project.failedCount > 0 && <span className="badge badge-red">{project.failedCount} fail</span>}
            {project.stuckCount > 0 && <span className="badge badge-orange">{project.stuckCount} stuck</span>}
            <span className="badge badge-gray">{project.kind}</span>
            {project.masterUrl && <span className="badge badge-accent"><Film size={10} style={{ marginRight: 3 }} />master</span>}
          </div>
        </>
      ) : (
        <div className="mono-sm py-1">{project.script ? "Pas de prompts trouvés" : "Pas de script associé"}</div>
      )}
    </Link>
  );
}
