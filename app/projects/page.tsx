"use client";

import { useProjects } from "@/components/projects/useProjectState";
import { ProjectCard } from "@/components/projects/ProjectCard";
import type { ProjectSummary, RunInfo } from "@/lib/projects/types";

interface Row extends ProjectSummary {
  activeRun?: RunInfo | null;
}

export default function ProjectsListPage() {
  const { data, error, loading } = useProjects();
  const rows = (data?.projects ?? []) as Row[];

  const live = rows.filter((p) => p.totalScenes > 0 && p.script);
  const inactive = rows.filter((p) => !(p.totalScenes > 0 && p.script));

  return (
    <div className="space-y-8 animate-in">
      <header>
        <div className="mono-sm mb-2">Workspace</div>
        <h1 className="heading-xl">Projects</h1>
        <p className="text-[14px] mt-2" style={{ color: "var(--text-secondary)" }}>
          Pipelines de génération vidéo. Cliquez sur un projet pour voir ses scènes et lancer des runs.
        </p>
      </header>

      {loading && !data && (
        <div className="glass-static py-16 text-center mono-sm">chargement…</div>
      )}

      {error && (
        <div className="glass-static py-6 px-5" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}

      {live.length > 0 && (
        <section className="space-y-4">
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {live.map((p) => (
              <ProjectCard key={p.slug} project={p} />
            ))}
          </div>
        </section>
      )}

      {inactive.length > 0 && (
        <section className="space-y-3">
          <h2 className="heading-md">Autres dossiers détectés</h2>
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {inactive.map((p) => (
              <ProjectCard key={p.slug} project={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
