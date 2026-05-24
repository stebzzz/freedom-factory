"use client";

import { useState } from "react";
import { Play, RotateCcw, AlertTriangle, Pause, Hourglass, Square, Film } from "lucide-react";
import type { ProjectState, RunMode } from "@/lib/projects/types";

interface Props {
  state: ProjectState;
  activeConcat: { id: string; status: string; clipsCount: number } | null;
  onAction: () => void;
}

interface ActionDef {
  mode: RunMode;
  label: string;
  Icon: typeof Play;
  hint?: string;
  variant?: "primary" | "glass";
  hideIfZero?: keyof ProjectState["counts"];
}

const ACTIONS: ActionDef[] = [
  { mode: "rolling", label: "Run all", Icon: Play, hint: "Lance toutes les scènes manquantes", variant: "primary" },
  { mode: "resume", label: "Resume", Icon: RotateCcw, hint: "Reprend les tasks en cours" },
  { mode: "failed-only", label: "Failed only", Icon: AlertTriangle, hint: "Relance les FAIL", hideIfZero: "failed" },
  { mode: "stuck-only", label: "Stuck only", Icon: Hourglass, hint: "Relance les STUCK", hideIfZero: "stuck" },
];

async function postRun(slug: string, mode: RunMode, opts: { ids?: number[]; force?: boolean } = {}) {
  const res = await fetch(`/api/projects/${slug}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, ...opts }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function postStop(slug: string) {
  const res = await fetch(`/api/projects/${slug}/stop`, { method: "POST" });
  return res.json();
}

async function postConcat(slug: string) {
  const res = await fetch(`/api/projects/${slug}/concat`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function RunControls({ state, activeConcat, onAction }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slug = state.project.slug;
  const isRunning = !!state.activeRun;
  const concatRunning = activeConcat?.status === "running";
  const canConcat = state.counts.done > 0 && !concatRunning;
  // Pipeline jobs (slug `job_*`) have no associated CLI script — multiRunner would throw
  // "Aucun script associé". Hide the modes that depend on a CLI script; the per-scene
  // image regen (handled in the modal) is the only flow that still works for them.
  const isPipelineJob = !state.project.script;

  const fire = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onAction();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        {ACTIONS.map((a) => {
          if (a.hideIfZero && state.counts[a.hideIfZero] === 0) return null;
          if (isPipelineJob) return null;
          const disabled = isRunning || busy !== null;
          const cls = a.variant === "primary" ? "btn-primary" : "btn-glass";
          return (
            <button
              key={a.mode}
              disabled={disabled}
              title={a.hint}
              onClick={() => fire(a.mode, () => postRun(slug, a.mode))}
              className={cls}
              style={{ opacity: disabled ? 0.5 : 1 }}
            >
              <a.Icon size={14} />
              {a.label}
              {busy === a.mode && <span className="ml-1 opacity-70">…</span>}
            </button>
          );
        })}

        {!isPipelineJob && <div className="w-px h-6" style={{ background: "var(--border-glass)" }} />}

        <button
          disabled={!canConcat || busy !== null}
          onClick={() => fire("concat", () => postConcat(slug))}
          className="btn-glass"
          title={canConcat ? `Concat des ${state.counts.done} clips → master.mp4` : "Concat indisponible (aucun clip prêt)"}
          style={{ opacity: !canConcat || busy !== null ? 0.5 : 1 }}
        >
          <Film size={14} />
          {concatRunning ? "Concat…" : "Concat master"}
          {busy === "concat" && <span className="ml-1 opacity-70">…</span>}
        </button>

        {isPipelineJob && (
          <span className="mono-sm ml-2" style={{ opacity: 0.6 }}>
            Pipeline job — edit/regen via la modal scène
          </span>
        )}

        {isRunning && (
          <button
            onClick={() => fire("stop", () => postStop(slug))}
            className="btn-glass"
            style={{ color: "var(--red)" }}
          >
            <Square size={14} />
            Stop
          </button>
        )}

        {state.activeRun && (
          <div className="flex items-center gap-2 ml-auto mono-sm">
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--green)" }} />
            run actif · {state.activeRun.mode}
            {state.activeRun.ids?.length ? ` · ids=${state.activeRun.ids.join(",")}` : ""}
          </div>
        )}
      </div>

      {error && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
