"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Clock, AlertCircle, Film, FileText, Mic, Image, Images, Music, Clapperboard, LayoutGrid, Library, X, Rocket, FlaskConical } from "lucide-react";

interface StepState {
  status: string;
  progress: number;
  message: string;
}

interface PilotResultClip {
  sceneIndex: number;
  clipPath: string;
}

interface JobState {
  id: string;
  status: string;
  currentStep: string | null;
  steps: Record<string, StepState>;
  result?: {
    montage?: { videoPath: string };
    animation?: PilotResultClip[];
  };
  params?: Record<string, unknown>;
  pilotIndices?: number[];
  resumedFromPilotId?: string;
}

const STEP_META: Record<string, { label: string; icon: React.ElementType; sub: string }> = {
  script:     { label: "Script",       icon: FileText,    sub: "Claude" },
  voiceover:  { label: "Voiceover",    icon: Mic,         sub: "ElevenLabs" },
  images:     { label: "Images",       icon: Image,       sub: "GenAIPro Veo" },
  premium:    { label: "Premium",      icon: Images,      sub: "GenAIPro Veo" },
  bulk:       { label: "B-Roll",       icon: Images,      sub: "GenAIPro Veo" },
  archives:   { label: "Archives",     icon: Library,     sub: "Wikimedia + Pexels" },
  animation:  { label: "Animation",    icon: Clapperboard, sub: "GenAIPro Veo3" },
  music:      { label: "Musique",      icon: Music,       sub: "Suno / Mubert" },
  thumbnails: { label: "Thumbnail",    icon: LayoutGrid,  sub: "GenAIPro Veo" },
  montage:    { label: "Montage",      icon: Film,        sub: "FFmpeg + Ken Burns" },
};

const STEP_ORDER = ["script", "voiceover", "images", "premium", "bulk", "archives", "animation", "music", "thumbnails", "montage"] as const;

function StepIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={15} className="text-emerald-400" />;
  if (status === "running")   return <Loader2 size={15} className="text-blue-400 animate-spin" />;
  if (status === "failed")    return <AlertCircle size={15} className="text-red-400" />;
  return <Clock size={15} style={{ color: "var(--text-tertiary)" }} />;
}

export function JobTracker({
  jobId,
  onClose,
  onRelaunch,
}: {
  jobId: string;
  onClose: () => void;
  onRelaunch?: (newJobId: string) => void;
}) {
  const [job, setJob] = useState<JobState | null>(null);
  const [connError, setConnError] = useState(false);
  const [relaunching, setRelaunching] = useState<"resume" | "clean" | null>(null);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      es = new EventSource(`/api/pipeline-status?id=${jobId}`);
      setConnError(false);

      es.onmessage = (e) => {
        retryRef.current = 0;
        const data = JSON.parse(e.data);

        if (data.type === "init") {
          setJob(data.job);
        } else if (data.type === "step") {
          setJob((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              currentStep: data.event.step,
              steps: {
                ...prev.steps,
                [data.event.step]: {
                  status: data.event.status,
                  progress: data.event.progress,
                  message: data.event.message,
                },
              },
            };
          });
        } else if (data.type === "done") {
          setJob((prev) => ({ ...(prev ?? {} as JobState), ...data.job }));
          es?.close();
        }
      };

      es.onerror = () => {
        es?.close();
        retryRef.current += 1;
        if (retryRef.current <= 5) {
          setConnError(true);
          retryTimeout = setTimeout(connect, 1500);
        }
      };
    }

    connect();
    return () => {
      es?.close();
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [jobId]);

  if (!job && !connError) return null;

  if (!job && connError) {
    return (
      <div className="glass-static rounded-xl px-5 py-4 flex items-center gap-3">
        <Loader2 size={16} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Connexion au pipeline... (tentative {retryRef.current}/5)
        </span>
        <button onClick={onClose} className="btn-glass ml-auto" style={{ padding: 4 }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  if (!job) return null;
  const isDone = job.status === "completed" || job.status === "failed";
  const videoUrl = job.result?.montage?.videoPath
    ? job.result.montage.videoPath.replace(/.*public/, "")
    : null;
  const isPilot = job.params?.pilotMode === true;
  const pilotClips = (job.result?.animation ?? []).map((c) => ({
    sceneIndex: c.sceneIndex,
    url: c.clipPath.replace(/.*public/, ""),
  }));

  async function relaunchFromPilot(mode: "resume" | "clean") {
    if (!job?.params || relaunching) return;
    setRelaunching(mode);
    setRelaunchError(null);
    try {
      const { pilotMode: _pm, pilotSampleSize: _ps, resumeFromPilotId: _rfp, ...basePayload } = job.params as Record<string, unknown>;
      const payload: Record<string, unknown> = { ...basePayload };
      if (mode === "resume") payload.resumeFromPilotId = job.id;
      const res = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.jobId) throw new Error(data.error || `HTTP ${res.status}`);
      onRelaunch?.(data.jobId);
    } catch (e) {
      setRelaunchError((e as Error).message);
    } finally {
      setRelaunching(null);
    }
  }

  // Only show steps that exist in the job
  const activeSteps = STEP_ORDER.filter((key) => key in job.steps);

  const completedCount = activeSteps.filter((k) => job.steps[k]?.status === "completed").length;
  const totalCount = activeSteps.length;

  return (
    <div
      className="glass-static overflow-hidden animate-in"
      style={{ borderRadius: "var(--radius-lg)" }}
    >
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border-glass)" }}>
        <div className="flex items-center gap-3">
          {isDone ? (
            job.status === "completed"
              ? <CheckCircle2 size={18} className="text-emerald-400" />
              : <AlertCircle size={18} className="text-red-400" />
          ) : (
            <Loader2 size={18} className="text-blue-400 animate-spin" />
          )}
          <div>
            <h3 className="heading-md text-[14px]">
              {isDone
                ? job.status === "completed" ? "Pipeline termine" : "Pipeline echoue"
                : connError
                ? "Reconnexion en cours..."
                : `Pipeline en cours... ${completedCount}/${totalCount}`}
            </h3>
            <span className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>{jobId}</span>
          </div>
        </div>
        <button onClick={onClose} className="btn-glass" style={{ padding: 4 }}>
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      {!isDone && (
        <div className="px-5 pt-3">
          <div className="h-[3px] rounded-full overflow-hidden" style={{ background: "var(--bg-glass-hover)" }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.round((completedCount / totalCount) * 100)}%`, background: "var(--blue)" }}
            />
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="px-5 py-3">
        {activeSteps.map((stepKey, idx) => {
          const step = job.steps[stepKey];
          if (!step) return null;
          const meta = STEP_META[stepKey];
          const Icon = meta?.icon || Film;
          const isLast = idx === activeSteps.length - 1;

          return (
            <div
              key={stepKey}
              className="flex items-center gap-3 py-2"
              style={{ borderBottom: !isLast ? "1px solid var(--border-glass)" : "none" }}
            >
              <StepIcon status={step.status} />
              <Icon size={13} style={{ color: "var(--text-tertiary)" }} />
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                  {meta?.label || stepKey}
                </span>
                <span className="text-[10px] font-mono ml-1.5" style={{ color: "var(--text-tertiary)" }}>
                  {meta?.sub}
                </span>
              </div>

              {step.status === "running" && (
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="progress-bar" style={{ width: 80 }}>
                    <div className="progress-fill" style={{ width: `${step.progress}%`, background: "var(--blue)" }} />
                  </div>
                  <span className="text-[11px] font-mono" style={{ color: "var(--blue)" }}>{step.progress}%</span>
                </div>
              )}

              <span className="text-[11px] truncate max-w-[140px]" style={{ color: "var(--text-tertiary)" }}>
                {step.message}
              </span>
            </div>
          );
        })}
      </div>

      {/* Results */}
      <>
        {isDone && job.status === "completed" && (
          <div className="px-5 pb-4 flex flex-col gap-3 animate-in">
            {/* Script */}
            <a
              href={`/api/script?id=${jobId}&format=txt`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-glass w-full justify-center"
            >
              <FileText size={14} /> Voir le script
            </a>

            {isPilot && pilotClips.length > 0 && (
              <>
                <div className="mono-sm" style={{ color: "var(--text-secondary)" }}>
                  Pilot — {pilotClips.length} clip{pilotClips.length > 1 ? "s" : ""} à valider
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {pilotClips.map((c) => (
                    <div
                      key={c.sceneIndex}
                      className="relative overflow-hidden"
                      style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", borderRadius: "var(--radius-sm)", aspectRatio: "16 / 9" }}
                    >
                      <video
                        src={c.url}
                        controls
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-mono rounded" style={{ background: "rgba(0,0,0,0.6)", color: "white" }}>
                        #{c.sceneIndex}
                      </div>
                    </div>
                  ))}
                </div>
                {relaunchError && (
                  <div className="px-3 py-2 text-[12px] rounded" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
                    {relaunchError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => relaunchFromPilot("resume")}
                    disabled={!!relaunching}
                    className="btn-primary justify-center"
                    style={{ padding: "10px 14px", opacity: relaunching ? 0.6 : 1 }}
                    title="Réutilise les 5 clips du pilot — ne re-génère que les scènes manquantes."
                  >
                    {relaunching === "resume" ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                    Full (resume pilot)
                  </button>
                  <button
                    onClick={() => relaunchFromPilot("clean")}
                    disabled={!!relaunching}
                    className="btn-glass justify-center"
                    style={{ padding: "10px 14px", opacity: relaunching ? 0.6 : 1 }}
                    title="Re-génère TOUTES les scènes from scratch, en gardant les mêmes paramètres."
                  >
                    {relaunching === "clean" ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
                    Full (clean)
                  </button>
                </div>
              </>
            )}

            {/* Video (non-pilot) */}
            {!isPilot && videoUrl && (
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary w-full justify-center"
              >
                <Film size={14} /> Voir la video
              </a>
            )}
          </div>
        )}
      </>
    </div>
  );
}
