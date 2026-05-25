"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, ImageIcon, Trash2, Sparkles } from "lucide-react";
import type { Scene } from "@/lib/projects/types";

interface Props {
  slug: string;
  scenes: Scene[];
  onClose: () => void;
  onDone: () => void;
}

interface ResultRow {
  id: number;
  ok: boolean;
  error?: string;
}

export function BatchRegenModal({ slug, scenes, onClose, onDone }: Props) {
  // Editable prompt per scene, keyed by id. Removing a row drops it from `order`.
  const [prompts, setPrompts] = useState<Record<number, string>>({});
  const [order, setOrder] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ids currently being rewritten from their VO
  const [rewriting, setRewriting] = useState<Set<number>>(new Set());

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const map: Record<number, string> = {};
    for (const s of scenes) map[s.id] = s.imagePrompt ?? "";
    setPrompts(map);
    setOrder(scenes.map((s) => s.id));
    setResults(null);
    setError(null);
  }, [scenes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  if (scenes.length === 0) return null;

  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const removeRow = (id: number) => setOrder((o) => o.filter((x) => x !== id));

  const rewriteRow = async (id: number) => {
    const scene = sceneById.get(id);
    const vo = scene?.vo?.trim();
    if (!vo) {
      setError(`Scène #${id} : pas de voice-over pour réécrire le prompt`);
      return;
    }
    setRewriting((s) => new Set(s).add(id));
    setError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/scenes/${id}/rewrite-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vo, currentPrompt: prompts[id] ?? "" }),
      });
      const data = (await res.json()) as { imagePrompt?: string; error?: string };
      if (!res.ok || !data.imagePrompt) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPrompts((p) => ({ ...p, [id]: data.imagePrompt as string }));
    } catch (e) {
      setError(`Réécriture #${id} : ${(e as Error).message}`);
    } finally {
      setRewriting((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const launch = async () => {
    if (order.length === 0) return;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      // Only send edited prompts (≠ original) to keep the payload lean; the route
      // falls back to script.json for the rest.
      const editedPrompts: Record<string, string> = {};
      for (const id of order) {
        const orig = sceneById.get(id)?.imagePrompt ?? "";
        if (prompts[id] !== undefined && prompts[id].trim() && prompts[id] !== orig) {
          editedPrompts[String(id)] = prompts[id].trim();
        }
      }
      const res = await fetch(`/api/projects/${slug}/regen-images`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: order, prompts: editedPrompts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResults(data.results ?? []);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resultById = new Map((results ?? []).map((r) => [r.id, r]));
  const okCount = (results ?? []).filter((r) => r.ok).length;

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)", animation: "fadeIn 0.18s ease-out" }}
      onClick={() => !busy && onClose()}
    >
      <div
        className="relative flex flex-col overflow-hidden"
        style={{
          width: "min(960px, 100%)",
          maxHeight: "calc(100vh - 48px)",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-glass-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid var(--border-glass)" }}>
          <div className="heading-md">
            Régénérer {order.length} image{order.length > 1 ? "s" : ""}
            {results && (
              <span className="mono-sm ml-3" style={{ color: okCount === results.length ? "var(--green)" : "var(--orange)" }}>
                {okCount}/{results.length} OK
              </span>
            )}
          </div>
          <button onClick={() => !busy && onClose()} className="btn-glass" style={{ padding: 6 }} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* Scrollable list of scenes */}
        <div className="overflow-y-auto px-6 py-4 space-y-3">
          {order.map((id) => {
            const scene = sceneById.get(id);
            if (!scene) return null;
            const r = resultById.get(id);
            return (
              <div
                key={id}
                className="flex gap-3 p-2.5"
                style={{
                  background: "var(--bg-glass-hover)",
                  border: `1px solid ${r ? (r.ok ? "var(--green)" : "var(--red)") : "var(--border-glass)"}`,
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {/* Thumbnail */}
                <div
                  className="relative flex-shrink-0"
                  style={{ width: 140, aspectRatio: "16 / 9", background: "black", borderRadius: "var(--radius-sm)", overflow: "hidden" }}
                >
                  {scene.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={scene.imageUrl} alt="" className="w-full h-full" style={{ objectFit: "cover" }} />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center mono-sm" style={{ opacity: 0.5 }}>
                      pas d&apos;image
                    </div>
                  )}
                  <div className="absolute top-1 left-1 mono-sm text-white/90" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.7)" }}>
                    #{String(id).padStart(3, "0")}
                  </div>
                </div>

                {/* Editable prompt */}
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  <textarea
                    value={prompts[id] ?? ""}
                    onChange={(e) => setPrompts((p) => ({ ...p, [id]: e.target.value }))}
                    disabled={busy}
                    rows={3}
                    placeholder="image prompt…"
                    className="w-full px-2.5 py-2 outline-none resize-y font-mono"
                    style={{
                      background: "var(--bg-primary)",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "var(--radius-sm)",
                      color: "var(--text-primary)",
                      fontSize: 11.5,
                      lineHeight: 1.45,
                    }}
                  />
                  {rewriting.has(id) && (
                    <span className="mono-sm" style={{ opacity: 0.7 }}>réécriture depuis la VO…</span>
                  )}
                  {r && !r.ok && (
                    <span className="mono-sm" style={{ color: "var(--red)" }}>{r.error}</span>
                  )}
                </div>

                {/* Per-row actions: rewrite prompt from VO, remove from batch */}
                <div className="flex flex-col gap-1.5 flex-shrink-0 self-start">
                  <button
                    onClick={() => rewriteRow(id)}
                    disabled={busy || rewriting.has(id) || !scene.vo?.trim()}
                    className="btn-glass"
                    style={{ padding: 6, opacity: busy || rewriting.has(id) || !scene.vo?.trim() ? 0.5 : 1 }}
                    title={scene.vo?.trim() ? "Réécrire l'image prompt depuis la voice-over (Claude)" : "Pas de voice-over sur cette scène"}
                  >
                    <Sparkles size={13} />
                  </button>
                  <button
                    onClick={() => removeRow(id)}
                    disabled={busy}
                    className="btn-glass"
                    style={{ padding: 6, opacity: busy ? 0.5 : 1 }}
                    title="Retirer de la sélection"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4" style={{ borderTop: "1px solid var(--border-glass)" }}>
          {error && <span className="mono-sm flex-1" style={{ color: "var(--red)" }}>{error}</span>}
          {busy && <span className="mono-sm flex-1" style={{ opacity: 0.8 }}>Régénération en cours… (Wan 3 en parallèle)</span>}
          <button onClick={() => !busy && onClose()} className="btn-glass" disabled={busy}>
            {results ? "Fermer" : "Annuler"}
          </button>
          <button
            onClick={launch}
            disabled={busy || order.length === 0}
            className="btn-primary"
            style={{ opacity: busy || order.length === 0 ? 0.5 : 1 }}
          >
            <ImageIcon size={14} />
            {busy ? "Régénération…" : results ? "Relancer" : `Regen ${order.length} image${order.length > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );

  return mounted ? createPortal(modal, document.body) : null;
}
