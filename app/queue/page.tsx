"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Trash2, Play, Pause, CheckCircle2, AlertCircle, Clock, Activity, RefreshCw } from "lucide-react";

interface QueueEntry {
  id: string;
  status: "waiting" | "running" | "completed" | "failed";
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  jobId?: string;
  error?: string;
  params: {
    title: string;
    niche: string;
    duration: number;
    presetId?: string;
    videoMode?: string;
    customScript?: string;
    pilotMode?: boolean;
  };
}

interface QueueState {
  entries: QueueEntry[];
  workerEnabled: boolean;
}

interface JobStepState {
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
}

interface PipelineImageResult {
  sceneIndex: number;
  imagePath: string;
  prompt: string;
}

interface PipelineJobShape {
  id: string;
  status: string;
  currentStep: string | null;
  steps: Record<string, JobStepState>;
  createdAt?: string;
  error?: string;
  params?: {
    title?: string;
    niche?: string;
    duration?: number;
    presetId?: string;
    videoMode?: string;
    pilotMode?: boolean;
    imageProvider?: string;
    geminigenModel?: string;
    voix?: string;
    voiceModel?: "genaipro" | "elevenlabs" | "fishspeech";
    voiceSpeed?: number;
  };
  result?: {
    images?: PipelineImageResult[];
    voiceover?: { audioPath: string; durationSeconds: number };
  };
  awaitingVoiceoverApproval?: boolean;
}

/** Convert a server-side imagePath like /abs/path/public/generated/<jobId>/images/scene_001.png
 *  into a browser-loadable URL `/generated/<jobId>/images/scene_001.png`. The pipeline runner
 *  uses the same logic but it lives server-side only. */
function imagePathToUrl(p: string): string {
  const idx = p.indexOf("/generated/");
  if (idx === -1) return p;
  return p.slice(idx);
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtElapsed(start?: string, end?: string): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

function statusVisual(s: QueueEntry["status"]) {
  if (s === "waiting") return { Icon: Clock, color: "var(--text-secondary)", label: "En attente" };
  if (s === "running") return { Icon: Activity, color: "var(--accent)", label: "En cours" };
  if (s === "completed") return { Icon: CheckCircle2, color: "var(--green)", label: "Terminé" };
  return { Icon: AlertCircle, color: "var(--red, #e0625a)", label: "Échec" };
}

const STEP_ORDER = ["script", "voiceover", "images", "premium", "bulk", "archives", "animation", "music", "thumbnails", "montage"] as const;

const STEP_LABELS: Record<string, { label: string; tooltip: string }> = {
  script: { label: "Script", tooltip: "Claude écrit le script + découpe en scènes" },
  voiceover: { label: "Voix off", tooltip: "Synthèse vocale ElevenLabs (via GenAIPro ou direct)" },
  images: { label: "Images", tooltip: "Génération image par scène (GenAIPro Veo)" },
  premium: { label: "Scènes clés", tooltip: "Re-gen hook/milieu/fin pour gain qualité" },
  bulk: { label: "B-roll alt", tooltip: "Variante d'image par scène (opt-in)" },
  archives: { label: "Archives", tooltip: "B-roll Wikimedia / Pexels (opt-in)" },
  animation: { label: "Animation", tooltip: "Veo i2v : transforme chaque image en clip" },
  music: { label: "Musique", tooltip: "Musique de fond générée" },
  thumbnails: { label: "Vignette", tooltip: "Thumbnail YouTube" },
  montage: { label: "Montage", tooltip: "Assemblage FFmpeg final (Ken Burns + sous-titres)" },
};

export default function QueuePage() {
  const [state, setState] = useState<QueueState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [jobStates, setJobStates] = useState<Record<string, PipelineJobShape>>({});

  const refresh = useCallback(async () => {
    try {
      // Fetch queue (worker) entries + all pipeline jobs in parallel.
      const [qRes, pRes] = await Promise.all([
        fetch("/api/queue", { cache: "no-store" }),
        fetch("/api/pipeline", { cache: "no-store" }),
      ]);
      const qData = await qRes.json();
      const pData = (await pRes.json()) as PipelineJobShape[];
      setErr(null);

      const queueEntries: QueueEntry[] = qData?.entries ?? [];
      const linkedJobIds = new Set(queueEntries.map((e) => e.jobId).filter(Boolean) as string[]);

      // For each pipeline job NOT linked to a queue entry, synthesize a queue-like entry
      // so the unified list shows EVERY job (direct launches + queue-managed) in one place.
      const directEntries: QueueEntry[] = pData
        .filter((j) => !linkedJobIds.has(j.id))
        .map((j) => {
          const stepValues = Object.values(j.steps ?? {});
          const startedAt = j.createdAt;
          const finishedAt =
            j.status === "completed" || j.status === "failed"
              ? stepValues.find((s) => s.status === "completed" && s.progress === 100)?.message
                ? undefined
                : undefined
              : undefined;
          const status: QueueEntry["status"] =
            j.status === "queued" ? "waiting"
              : j.status === "running" ? "running"
              : j.status === "completed" ? "completed"
              : "failed";
          return {
            id: `direct_${j.id}`,
            status,
            addedAt: j.createdAt ?? new Date().toISOString(),
            startedAt,
            finishedAt,
            jobId: j.id,
            error: j.error,
            params: {
              title: j.params?.title ?? "(direct launch)",
              niche: j.params?.niche ?? "",
              duration: j.params?.duration ?? 0,
              presetId: j.params?.presetId,
              videoMode: j.params?.videoMode,
              pilotMode: j.params?.pilotMode,
            },
          };
        });

      // Merge + sort by most recent activity first (running > waiting > recent finished > older).
      const allEntries = [...queueEntries, ...directEntries].sort((a, b) => {
        const rank = (e: QueueEntry) => (e.status === "running" ? 0 : e.status === "waiting" ? 1 : 2);
        const dr = rank(a) - rank(b);
        if (dr !== 0) return dr;
        const ta = new Date(a.startedAt ?? a.addedAt).getTime();
        const tb = new Date(b.startedAt ?? b.addedAt).getTime();
        return tb - ta;
      });

      setState({ entries: allEntries, workerEnabled: !!qData?.workerEnabled });

      // Build job-state map for all entries with a jobId currently running/recent.
      const idsToTrack = allEntries
        .filter((e) => e.jobId && (e.status === "running" || (e.status === "completed" && e.finishedAt && Date.now() - new Date(e.finishedAt).getTime() < 5 * 60_000) || e.status === "failed"))
        .map((e) => e.jobId!) as string[];
      const next: Record<string, PipelineJobShape> = {};
      for (const j of pData) if (idsToTrack.includes(j.id)) next[j.id] = j;
      setJobStates(next);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const sendVoiceoverDecision = useCallback(async (
    jobId: string,
    decision: "approve" | "regenerate" | "cancel",
    overrides?: { voix?: string; voiceModel?: string; voiceSpeed?: number },
  ) => {
    try {
      const res = await fetch("/api/pipeline/voiceover-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, decision, overrides }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      refresh();
    } catch (e) {
      setErr(`voiceover decision: ${(e as Error).message}`);
    }
  }, [refresh]);

  const toggleWorker = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const r = await fetch("/api/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerEnabled: !state.workerEnabled }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setState(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/queue?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clearFinished = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/queue?id=__finished__", { method: "DELETE" });
      if (!r.ok) {
        const data = await r.json();
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="space-y-8 animate-in">
        <header>
          <div className="mono-sm mb-2">Workspace · File d&apos;attente</div>
          <h1 className="heading-xl">Queue de jobs</h1>
          <p className="text-[14px] mt-2" style={{ color: "var(--text-secondary)" }}>Chargement…</p>
        </header>
      </div>
    );
  }

  const waiting = state.entries.filter((e) => e.status === "waiting").length;
  const running = state.entries.filter((e) => e.status === "running").length;
  const completed = state.entries.filter((e) => e.status === "completed").length;
  const failed = state.entries.filter((e) => e.status === "failed").length;

  return (
    <div className="space-y-6 animate-in pb-12">
      <header>
        <div className="mono-sm mb-2">Workspace · File d&apos;attente</div>
        <h1 className="heading-xl">Queue de jobs</h1>
        <p className="text-[14px] mt-2 max-w-2xl" style={{ color: "var(--text-secondary)" }}>
          Ajoute des vidéos depuis <a href="/pipeline" className="underline" style={{ color: "var(--accent)" }}>/pipeline</a> (bouton &quot;Ajouter à la queue&quot;). Le worker en lance une seule à la fois, séquentiellement.
        </p>
      </header>

      {err && (
        <div className="px-3 py-2 rounded text-[13px]" style={{ background: "var(--red-bg, #3a1f1f)", color: "var(--red, #e0625a)" }}>
          {err}
        </div>
      )}

      {/* Worker toggle + counters */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-lg" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
        <button
          onClick={toggleWorker}
          disabled={busy}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-[13px] font-medium"
          style={{
            background: state.workerEnabled ? "var(--accent-bg)" : "var(--bg-glass-strong, #2a2a2a)",
            color: state.workerEnabled ? "var(--accent)" : "var(--text-secondary)",
            border: `1px solid ${state.workerEnabled ? "var(--accent)" : "var(--border-glass)"}`,
          }}
        >
          {state.workerEnabled ? <Pause size={13} /> : <Play size={13} />}
          {state.workerEnabled ? "Worker actif — Pause" : "Worker en pause — Reprendre"}
        </button>
        <div className="flex items-center gap-4 text-[12px] ml-2" style={{ color: "var(--text-secondary)" }}>
          <span>Waiting: <b style={{ color: "var(--text-primary)" }}>{waiting}</b></span>
          <span>Running: <b style={{ color: "var(--accent)" }}>{running}</b></span>
          <span>Done: <b style={{ color: "var(--green)" }}>{completed}</b></span>
          <span>Failed: <b style={{ color: "var(--red, #e0625a)" }}>{failed}</b></span>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={refresh}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px]"
            style={{ background: "var(--bg-glass-strong, #2a2a2a)", border: "1px solid var(--border-glass)", color: "var(--text-secondary)" }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          {(completed + failed) > 0 && (
            <button
              onClick={clearFinished}
              disabled={busy}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px]"
              style={{ background: "var(--bg-glass-strong, #2a2a2a)", border: "1px solid var(--border-glass)", color: "var(--text-secondary)" }}
            >
              <Trash2 size={12} /> Clear finis ({completed + failed})
            </button>
          )}
        </div>
      </div>

      {/* Entries list */}
      {state.entries.length === 0 ? (
        <div className="px-6 py-12 rounded-lg text-center" style={{ background: "var(--bg-glass)", border: "1px dashed var(--border-glass)", color: "var(--text-tertiary)" }}>
          Queue vide. Va sur <a href="/pipeline" className="underline" style={{ color: "var(--accent)" }}>/pipeline</a> pour ajouter un job.
        </div>
      ) : (
        <div className="space-y-2">
          {state.entries.map((e) => {
            const v = statusVisual(e.status);
            const isDirect = e.id.startsWith("direct_");
            const removable = e.status === "waiting" && !isDirect;
            const job = e.jobId ? jobStates[e.jobId] : undefined;
            const activeStep = job?.currentStep;
            const stepEntries = job
              ? STEP_ORDER.filter((name) => job.steps?.[name]).map((name) => ({ name, ...job.steps[name] }))
              : [];
            const overallProgress = (() => {
              if (!job) return null;
              if (job.status === "completed") return 100;
              if (job.status === "failed") return 0;
              const done = stepEntries.filter((s) => s.status === "completed").length;
              const running = stepEntries.find((s) => s.status === "running");
              const total = stepEntries.length || 1;
              const partial = running ? running.progress / 100 : 0;
              return Math.min(100, Math.round(((done + partial) / total) * 100));
            })();
            return (
              <div key={e.id} className="px-4 py-3 rounded-lg flex flex-col gap-2" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
                <div className="flex items-center gap-3">
                  <div style={{ color: v.color }} className="flex items-center gap-2 min-w-[110px]">
                    {e.status === "running" ? <Loader2 size={14} className="animate-spin" /> : <v.Icon size={14} />}
                    <span className="text-[12px] font-medium">{v.label}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 truncate">
                      <span className="text-[14px] font-medium truncate" style={{ color: "var(--text-primary)" }}>{e.params.title || "(sans titre)"}</span>
                      <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>·</span>
                      <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>{e.params.niche}</span>
                      <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>·</span>
                      <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>{e.params.duration}min</span>
                      {e.params.pilotMode && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>pilot</span>
                      )}
                      {e.params.videoMode && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-strong, #2a2a2a)", color: "var(--text-tertiary)" }}>{e.params.videoMode}</span>
                      )}
                      {isDirect && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-strong, #2a2a2a)", color: "var(--text-secondary)" }} title="Lancé directement via /pipeline (hors queue)">
                          direct
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
                      Ajouté {fmtDate(e.addedAt)}
                      {e.startedAt && ` · démarré ${fmtDate(e.startedAt)} (${fmtElapsed(e.startedAt, e.finishedAt)})`}
                      {e.jobId && (
                        <> · <a href={`/pipeline`} className="underline" style={{ color: "var(--text-secondary)" }}>{e.jobId.slice(0, 16)}…</a></>
                      )}
                    </div>
                    {e.error && (
                      <div className="text-[11px] mt-1 px-2 py-1 rounded" style={{ background: "var(--red-bg, #3a1f1f)", color: "var(--red, #e0625a)" }}>
                        {e.error.slice(0, 200)}
                      </div>
                    )}
                  </div>
                  {removable && (
                    <button
                      onClick={() => removeOne(e.id)}
                      disabled={busy}
                      className="p-1.5 rounded"
                      style={{ color: "var(--text-tertiary)" }}
                      title="Retirer de la queue"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                {/* Progression live: overall bar + per-step pills, only when we have a job snapshot. */}
                {job && stepEntries.length > 0 && (
                  <div className="mt-1 pl-[110px]">
                    {overallProgress !== null && (
                      <div className="flex items-center gap-2 mb-2">
                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-glass-strong, #2a2a2a)" }}>
                          <div
                            className="h-full transition-all duration-500"
                            style={{
                              width: `${overallProgress}%`,
                              background: job.status === "failed" ? "var(--red, #e0625a)" : "var(--accent)",
                            }}
                          />
                        </div>
                        <span className="text-[11px] tabular-nums" style={{ color: "var(--text-secondary)", minWidth: 38, textAlign: "right" }}>
                          {overallProgress}%
                        </span>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {stepEntries.map((s) => {
                        const isActive = s.name === activeStep && s.status === "running";
                        const isDone = s.status === "completed";
                        const isFailed = s.status === "failed";
                        const labelInfo = STEP_LABELS[s.name] ?? { label: s.name, tooltip: "" };
                        return (
                          <div
                            key={s.name}
                            className="text-[10px] px-2 py-1 rounded flex items-center gap-1.5"
                            style={{
                              background: isActive ? "var(--accent-bg)" : isDone ? "var(--bg-glass-strong, #2a2a2a)" : "var(--bg-glass)",
                              border: `1px solid ${isActive ? "var(--accent)" : isFailed ? "var(--red, #e0625a)" : "var(--border-glass)"}`,
                              color: isActive ? "var(--accent)" : isFailed ? "var(--red, #e0625a)" : isDone ? "var(--green)" : "var(--text-tertiary)",
                            }}
                            title={`${labelInfo.tooltip}${s.message ? ` — ${s.message}` : ""}`}
                          >
                            {isActive && <Loader2 size={9} className="animate-spin" />}
                            {isDone && <CheckCircle2 size={9} />}
                            {isFailed && <AlertCircle size={9} />}
                            <span className="font-medium">{labelInfo.label}</span>
                            {isActive && <span className="tabular-nums">{s.progress}%</span>}
                          </div>
                        );
                      })}
                    </div>
                    {activeStep && job.steps?.[activeStep]?.message && (
                      <div className="text-[11px] mt-1.5 italic" style={{ color: "var(--text-secondary)" }}>
                        {job.steps[activeStep].message}
                      </div>
                    )}

                    {/* Voiceover gate — pause for explicit approval before image generation. */}
                    {job.awaitingVoiceoverApproval && job.result?.voiceover && (
                      <div className="mt-3 p-3 rounded" style={{ background: "var(--accent-bg)", border: "1px solid var(--accent)" }}>
                        <div className="text-[12px] font-medium mb-2" style={{ color: "var(--accent)" }}>
                          Validation requise — écoute la voix off avant que les images soient générées.
                        </div>
                        <audio
                          controls
                          src={imagePathToUrl(job.result.voiceover.audioPath)}
                          style={{ width: "100%", height: 36 }}
                        />
                        <div className="text-[10px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>
                          {job.params?.voiceModel && `Modèle: ${job.params.voiceModel}`}
                          {job.params?.voix && ` · Voix: ${job.params.voix.slice(0, 12)}${job.params.voix.length > 12 ? "…" : ""}`}
                          {typeof job.params?.voiceSpeed === "number" && ` · Vitesse: ${job.params.voiceSpeed}`}
                          {` · Durée: ${job.result.voiceover.durationSeconds}s`}
                        </div>
                        <div className="flex gap-2 mt-2.5">
                          <button
                            onClick={() => sendVoiceoverDecision(job.id, "approve")}
                            className="px-3 py-1.5 rounded text-[12px] font-medium"
                            style={{ background: "var(--green)", color: "white" }}
                          >
                            ✓ Valider — lance les images
                          </button>
                          <button
                            onClick={() => sendVoiceoverDecision(job.id, "regenerate")}
                            className="px-3 py-1.5 rounded text-[12px] font-medium"
                            style={{ background: "var(--bg-glass-strong, #2a2a2a)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" }}
                            title="Re-génère le voiceover avec les mêmes params"
                          >
                            ↻ Refaire la voix off
                          </button>
                          <button
                            onClick={() => sendVoiceoverDecision(job.id, "cancel")}
                            className="px-3 py-1.5 rounded text-[12px]"
                            style={{ background: "transparent", border: "1px solid var(--red, #e0625a)", color: "var(--red, #e0625a)" }}
                          >
                            Annuler le job
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Live thumbnails — appear as each scene finishes its image-gen call. */}
                    {(() => {
                      const imgs = job.result?.images ?? [];
                      if (imgs.length === 0) return null;
                      const sorted = [...imgs].sort((a, b) => a.sceneIndex - b.sceneIndex);
                      return (
                        <div className="mt-2.5">
                          <div className="text-[11px] mb-1.5" style={{ color: "var(--text-tertiary)" }}>
                            Images générées · {sorted.length}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {sorted.map((img) => {
                              const url = imagePathToUrl(img.imagePath);
                              return (
                                <a
                                  key={`${img.sceneIndex}-${img.imagePath}`}
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="relative block rounded overflow-hidden"
                                  style={{
                                    width: 64,
                                    height: 36,
                                    background: `url(${url}) center/cover, var(--bg-glass-strong, #2a2a2a)`,
                                    border: "1px solid var(--border-glass)",
                                  }}
                                  title={`scène ${img.sceneIndex} — ${img.prompt.slice(0, 140)}${img.prompt.length > 140 ? "…" : ""}`}
                                >
                                  <span
                                    className="absolute bottom-0 left-0 px-1 text-[9px] font-mono tabular-nums"
                                    style={{ background: "rgba(0,0,0,0.6)", color: "white", lineHeight: 1.4 }}
                                  >
                                    {img.sceneIndex}
                                  </span>
                                </a>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
