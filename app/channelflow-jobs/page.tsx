"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2, Trash2, Play, Pause, CheckCircle2, AlertCircle, Clock, Activity,
  RefreshCw, Pencil, X, ExternalLink, Film,
} from "lucide-react";

interface CFParams {
  title: string;
  niche: string;
  duration: number;
  presetId?: string;
  styleKitSlug?: string;
  voix?: string;
  customScript?: string;
  pilotMode?: boolean;
  channelflowVideoId?: string;
  channelflowChannelId?: string;
  voiceModel?: string;
  videoMode?: string;
  imageProvider?: string;
}

interface QEntry {
  id: string;
  status: "waiting" | "running" | "completed" | "failed";
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  jobId?: string;
  error?: string;
  params: CFParams;
}

interface QState {
  entries: QEntry[];
  workerEnabled: boolean;
}

interface Job {
  id: string;
  status: string;
  currentStep: string | null;
  steps: Record<string, { status: string; progress: number; message: string }>;
  error?: string;
  result?: { montage?: { videoPath: string } };
}

function genUrl(p?: string): string | null {
  if (!p) return null;
  const idx = p.indexOf("/generated/");
  return idx === -1 ? null : p.slice(idx);
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statusVisual(s: QEntry["status"]) {
  if (s === "waiting") return { Icon: Clock, color: "var(--text-secondary)", label: "En file" };
  if (s === "running") return { Icon: Activity, color: "var(--accent)", label: "En cours" };
  if (s === "completed") return { Icon: CheckCircle2, color: "var(--green, #4caf7d)", label: "Terminé" };
  return { Icon: AlertCircle, color: "var(--red, #e0625a)", label: "Échec" };
}

function jobProgress(job?: Job): string {
  if (!job) return "";
  const steps = Object.values(job.steps || {});
  if (steps.length === 0) return "";
  const done = steps.filter((s) => s.status === "completed").length;
  if (job.status === "running" && job.currentStep) {
    const cur = job.steps[job.currentStep];
    return `${job.currentStep} ${cur ? `${cur.progress}%` : ""} · ${done}/${steps.length}`;
  }
  return `${done}/${steps.length} étapes`;
}

export default function ChannelFlowJobsPage() {
  const [state, setState] = useState<QState | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [editing, setEditing] = useState<QEntry | null>(null);
  const [kits, setKits] = useState<string[]>([]);
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);

  const fetchAll = useCallback(async () => {
    try {
      const [qRes, pRes] = await Promise.all([
        fetch("/api/queue", { cache: "no-store" }),
        fetch("/api/pipeline", { cache: "no-store" }),
      ]);
      const q = qRes.ok ? ((await qRes.json()) as QState) : null;
      const p = pRes.ok ? ((await pRes.json()) as Job[]) : [];
      setState(q);
      setJobs(Array.isArray(p) ? p : []);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 4000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // Métadonnées pour l'éditeur (même origine → pas de CORS)
  useEffect(() => {
    (async () => {
      try {
        const [k, pr] = await Promise.all([
          fetch("/api/style-kit", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/presets", { cache: "no-store" }).then((r) => r.json()),
        ]);
        setKits((k?.kits ?? []).map((x: { slug: string }) => x.slug));
        setPresets((Array.isArray(pr) ? pr : []).map((x: { id: string; label: string }) => ({ id: x.id, label: x.label })));
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function flash(type: "ok" | "err", msg: string) {
    setNotice({ type, msg });
    setTimeout(() => setNotice(null), 5000);
  }

  const cfEntries = (state?.entries ?? []).filter((e) => e.params?.channelflowVideoId);
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  async function patch(body: Record<string, unknown>) {
    const res = await fetch("/api/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function onRun(id: string) {
    setBusyId(id);
    try {
      await patch({ id, run: true });
      flash("ok", "Lancement demandé.");
      await fetchAll();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onRemove(id: string) {
    if (!confirm("Retirer ce job de la file ?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/queue?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      flash("ok", "Retiré.");
      await fetchAll();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onToggleWorker() {
    try {
      await patch({ workerEnabled: !state?.workerEnabled });
      await fetchAll();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    }
  }

  async function onSaveEdit(patchParams: Partial<CFParams>) {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      await patch({ id: editing.id, params: patchParams });
      flash("ok", "Job mis à jour.");
      setEditing(null);
      await fetchAll();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Jobs ChannelFlow
          </h1>
          <p className="text-[13px] mt-1" style={{ color: "var(--text-secondary)" }}>
            Vidéos envoyées depuis ChannelFlow. Worker en pause = lance-les ici une par une.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onToggleWorker} className="btn-glass" title="Pause / reprise du worker global">
            {state?.workerEnabled ? <Pause size={14} /> : <Play size={14} />}
            <span className="ml-1.5 text-[12px]">{state?.workerEnabled ? "Worker actif" : "Worker en pause"}</span>
          </button>
          <button onClick={fetchAll} className="btn-glass" title="Rafraîchir">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {notice && (
        <div
          className="mb-4 px-4 py-2.5 rounded-[12px] text-[13px] font-medium"
          style={{
            background: notice.type === "ok" ? "var(--green-bg, rgba(76,175,125,0.15))" : "var(--red-bg, rgba(224,98,90,0.15))",
            color: notice.type === "ok" ? "var(--green, #4caf7d)" : "var(--red, #e0625a)",
          }}
        >
          {notice.msg}
        </div>
      )}

      {!state ? (
        <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <Loader2 size={16} className="animate-spin" /> Chargement…
        </div>
      ) : cfEntries.length === 0 ? (
        <div
          className="rounded-[16px] p-10 text-center text-[13px]"
          style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", color: "var(--text-secondary)" }}
        >
          Aucun job venant de ChannelFlow pour l'instant.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {cfEntries.map((e) => {
            const v = statusVisual(e.status);
            const job = jobById.get(e.jobId || "");
            const videoUrl = genUrl(job?.result?.montage?.videoPath);
            const isBusy = busyId === e.id;
            return (
              <div
                key={e.id}
                className="rounded-[16px] p-4"
                style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <v.Icon size={16} style={{ color: v.color }} />
                      <span className="text-[14px] font-semibold truncate" style={{ color: "var(--text-primary)" }}>
                        {e.params.title || "(sans titre)"}
                      </span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "var(--bg-glass-strong, #2a2a2a)", color: v.color }}>
                        {v.label}
                      </span>
                      {e.params.pilotMode && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: "var(--accent)", color: "#fff" }}>
                          🔬 PILOTE
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: "var(--text-secondary)" }}>
                      <span>niche : {e.params.niche || "—"}</span>
                      <span>durée : {e.params.duration ?? "—"} min</span>
                      <span>kit : {e.params.styleKitSlug || "style-kit-def"}</span>
                      <span>preset : {e.params.presetId || "défaut"}</span>
                      <span>ajouté {fmtDate(e.addedAt)}</span>
                      {e.status === "running" && <span style={{ color: "var(--accent)" }}>{jobProgress(job)}</span>}
                    </div>
                    {e.error && <div className="text-[12px] mt-1" style={{ color: "var(--red, #e0625a)" }}>{e.error}</div>}
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {videoUrl && (
                      <a href={videoUrl} target="_blank" rel="noreferrer" className="btn-glass" title="Voir la vidéo">
                        <Film size={14} />
                      </a>
                    )}
                    {e.status === "waiting" && (
                      <>
                        <button onClick={() => setEditing(e)} disabled={isBusy} className="btn-glass" title="Modifier">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => onRun(e.id)} disabled={isBusy} className="btn-glass" title="Lancer maintenant" style={{ color: "var(--accent)" }}>
                          {isBusy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                        </button>
                      </>
                    )}
                    {(e.status === "waiting" || e.status === "completed" || e.status === "failed") && (
                      <button onClick={() => onRemove(e.id)} disabled={isBusy} className="btn-glass" title="Retirer" style={{ color: "var(--red, #e0625a)" }}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <EditModal
          entry={editing}
          kits={kits}
          presets={presets}
          onClose={() => setEditing(null)}
          onSave={onSaveEdit}
        />
      )}
    </div>
  );
}

function EditModal({
  entry, kits, presets, onClose, onSave,
}: {
  entry: QEntry;
  kits: string[];
  presets: { id: string; label: string }[];
  onClose: () => void;
  onSave: (p: Partial<CFParams>) => void;
}) {
  const [title, setTitle] = useState(entry.params.title ?? "");
  const [niche, setNiche] = useState(entry.params.niche ?? "");
  const [duration, setDuration] = useState(entry.params.duration ?? 10);
  const [presetId, setPresetId] = useState(entry.params.presetId ?? "");
  const [styleKitSlug, setStyleKitSlug] = useState(entry.params.styleKitSlug ?? "style-kit-def");
  const [voix, setVoix] = useState(entry.params.voix ?? "");
  const [customScript, setCustomScript] = useState(entry.params.customScript ?? "");
  const [pilotMode, setPilotMode] = useState(entry.params.pilotMode ?? false);

  const field = "w-full rounded-[10px] px-3 py-2 text-[13px] mb-3";
  const fieldStyle = { background: "var(--bg-glass-strong, #1e1e1e)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" } as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full max-w-[560px] max-h-[88vh] overflow-y-auto rounded-[18px] p-5"
        style={{ background: "var(--bg-primary, #161616)", border: "1px solid var(--border-glass)" }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[16px] font-bold" style={{ color: "var(--text-primary)" }}>Modifier le job</h2>
          <button onClick={onClose} className="btn-glass"><X size={14} /></button>
        </div>

        <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Titre</label>
        <input className={field} style={fieldStyle} value={title} onChange={(e) => setTitle(e.target.value)} />

        <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Niche</label>
        <input className={field} style={fieldStyle} value={niche} onChange={(e) => setNiche(e.target.value)} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Durée (min)</label>
            <input type="number" min={1} className={field} style={fieldStyle} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </div>
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Style kit</label>
            <select className={field} style={fieldStyle} value={styleKitSlug} onChange={(e) => setStyleKitSlug(e.target.value)}>
              {(kits.length ? kits : [styleKitSlug]).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Preset</label>
            <select className={field} style={fieldStyle} value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">— défaut —</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Voix ElevenLabs (ID)</label>
            <input className={field} style={fieldStyle} value={voix} onChange={(e) => setVoix(e.target.value)} placeholder="vide = voix globale" />
          </div>
        </div>

        <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
          <input type="checkbox" checked={pilotMode} onChange={(e) => setPilotMode(e.target.checked)} className="w-4 h-4" />
          <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>Mode pilote</span>
          <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>— QA 5 scènes, pas de montage</span>
        </label>

        <label className="text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>Script</label>
        <textarea rows={8} className={field + " font-mono"} style={fieldStyle} value={customScript} onChange={(e) => setCustomScript(e.target.value)} />

        <div className="flex justify-end gap-2 mt-2">
          <button onClick={onClose} className="btn-glass text-[13px]">Annuler</button>
          <button
            onClick={() =>
              onSave({
                title: title.trim(),
                niche: niche.trim(),
                duration: Number.isFinite(duration) && duration > 0 ? duration : 10,
                presetId: presetId.trim() || undefined,
                styleKitSlug: styleKitSlug.trim() || "style-kit-def",
                voix: voix.trim() || "",
                customScript: customScript,
                pilotMode: pilotMode,
              })
            }
            className="px-4 py-2 rounded-[10px] text-[13px] font-semibold text-white"
            style={{ background: "var(--accent)" }}
          >
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
