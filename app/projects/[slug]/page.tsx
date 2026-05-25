"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Film, Download, Volume2, VolumeX, Scissors } from "lucide-react";
import { useProjectState } from "@/components/projects/useProjectState";
import { RunControls } from "@/components/projects/RunControls";
import { ScenesGrid } from "@/components/projects/ScenesGrid";
import { ScenePromptDrawer } from "@/components/projects/ScenePromptDrawer";
import { PipelineFinalizePanel } from "@/components/projects/PipelineFinalizePanel";
import { RunLogPanel } from "@/components/projects/RunLogPanel";
import { usePreviewAudio } from "@/components/projects/usePreviewAudio";
import type { Scene } from "@/lib/projects/types";

export default function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { data, error, loading, refetch } = useProjectState(slug);
  const [openScene, setOpenScene] = useState<Scene | null>(null);
  const [previewAudio, setPreviewAudio] = usePreviewAudio();

  if (loading && !data) {
    return <div className="glass-static py-16 text-center mono-sm">chargement…</div>;
  }
  if (error || !data) {
    return (
      <div className="glass-static py-6 px-5" style={{ color: "var(--red)" }}>
        {error || "Projet introuvable"}
        <div className="mt-4">
          <Link href="/projects" className="btn-glass">
            <ChevronLeft size={14} />
            Retour
          </Link>
        </div>
      </div>
    );
  }

  const { project, scenes, counts, activeRun, activeConcat } = data;

  // Live scene if currently in drawer should reflect updates.
  const liveScene = openScene ? scenes.find((s) => s.id === openScene.id) ?? openScene : null;

  return (
    <div className="space-y-6 animate-in pb-16">
      <div>
        <Link href="/projects" className="mono-sm inline-flex items-center gap-1 hover:opacity-100 opacity-70">
          <ChevronLeft size={12} /> Tous les projets
        </Link>
      </div>

      <header className="flex flex-wrap items-end gap-6">
        <div className="flex-1 min-w-0">
          <div className="mono-sm mb-2">{project.kind} · {project.slug}</div>
          <h1 className="heading-xl">{project.label}</h1>
          {project.description && (
            <p className="text-[14px] mt-2 max-w-2xl" style={{ color: "var(--text-secondary)" }}>
              {project.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-6">
          <Stat label="Done" value={counts.done} accent="green" />
          <Stat label="Pending" value={counts.pending} accent={counts.pending > 0 ? "blue" : undefined} />
          <Stat label="Failed" value={counts.failed} accent={counts.failed > 0 ? "red" : undefined} />
          <Stat label="Stuck" value={counts.stuck} accent={counts.stuck > 0 ? "orange" : undefined} />
          <Stat label="Total" value={counts.total} />
        </div>
      </header>

      {project.totalScenes > 0 && (
        <div className="progress-bar" style={{ height: 4 }}>
          <div className="progress-fill" style={{ width: `${Math.round((counts.done / Math.max(1, counts.total)) * 100)}%` }} />
        </div>
      )}

      <div className="glass-static p-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <RunControls state={data} activeConcat={activeConcat ?? null} onAction={refetch} />
        </div>
        <button
          type="button"
          onClick={() => setPreviewAudio(!previewAudio)}
          className="btn-glass flex-shrink-0"
          title={previewAudio ? "Couper le son du preview au survol" : "Activer le son du preview au survol"}
          aria-pressed={previewAudio}
        >
          {previewAudio ? <Volume2 size={14} /> : <VolumeX size={14} />}
          <span className="text-[12px]">Preview audio {previewAudio ? "ON" : "OFF"}</span>
        </button>
        <Link href={`/projects/${slug}/edit`} className="btn-glass flex-shrink-0">
          <Scissors size={14} />
          <span className="text-[12px]">Editor Remotion</span>
        </Link>
      </div>

      {project.masterUrl && (() => {
        // Download the final cut named after the project title (e.g. "Phones
        // Existed.mp4") instead of the generic output.mp4. The server file is
        // left as-is (registry detects output.mp4/master.mp4); only the browser
        // download filename is set via the `download` attribute.
        const safeTitle = (project.label || "video").replace(/[\\/:*?"<>|]/g, "").trim() || "video";
        const downloadName = `${safeTitle}.mp4`;
        return (
          <div className="glass-static p-4 flex items-center gap-4">
            <Film size={18} style={{ color: "var(--accent)" }} />
            <div className="flex-1">
              <div className="heading-md">{downloadName}</div>
              <div className="mono-sm">
                {project.masterUpdatedAt ? new Date(project.masterUpdatedAt).toLocaleString() : ""}
              </div>
            </div>
            <a href={project.masterUrl} target="_blank" rel="noreferrer" className="btn-glass">
              <Film size={14} />
              Preview
            </a>
            <a href={project.masterUrl} download={downloadName} className="btn-glass">
              <Download size={14} />
              Télécharger
            </a>
          </div>
        );
      })()}

      {!project.script && (
        <PipelineFinalizePanel slug={slug} onAction={refetch} />
      )}

      <ScenesGrid scenes={scenes} onSceneClick={(s) => setOpenScene(s)} slug={slug} onAction={refetch} />

      <ScenePromptDrawer
        slug={slug}
        scene={liveScene}
        kind={project.kind}
        onClose={() => setOpenScene(null)}
        onSaved={refetch}
      />

      <RunLogPanel slug={slug} runId={activeRun?.id} active={!!activeRun} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "green" | "blue" | "red" | "orange" }) {
  const color =
    accent === "green" ? "var(--green)" :
    accent === "blue" ? "var(--blue)" :
    accent === "red" ? "var(--red)" :
    accent === "orange" ? "var(--orange)" :
    "var(--text-primary)";
  return (
    <div className="flex flex-col">
      <span className="stat-value" style={{ color }}>{value}</span>
      <span className="stat-label uppercase">{label}</span>
    </div>
  );
}
