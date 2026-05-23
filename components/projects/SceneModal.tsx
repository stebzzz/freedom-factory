"use client";

import { useEffect, useState } from "react";
import { X, Sparkles, RefreshCw, Loader2, Save } from "lucide-react";
import type { RemotionClip } from "@/remotion/types";

interface Props {
  clip: RemotionClip;
  slug: string;
  fps: number;
  onClose: () => void;
  onClipUpdated: (updated: RemotionClip) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "ai-rewriting" }
  | { kind: "regenerating" }
  | { kind: "error"; message: string }
  | { kind: "regenerated"; newUrl: string };

export function SceneModal({ clip, slug, fps, onClose, onClipUpdated }: Props) {
  const [prompt, setPrompt] = useState<string>(clip.prompt ?? "");
  const [aiInstruction, setAiInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Reset state when a different clip is opened.
  useEffect(() => {
    setPrompt(clip.prompt ?? "");
    setAiInstruction("");
    setPhase({ kind: "idle" });
  }, [clip.id, clip.prompt]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const runAiRewrite = async () => {
    setPhase({ kind: "ai-rewriting" });
    try {
      const res = await fetch("/api/improve-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, instruction: aiInstruction || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const data = await res.json() as { prompt: string };
      setPrompt(data.prompt);
      setPhase({ kind: "idle" });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const runRegenerate = async () => {
    if (typeof clip.sceneId !== "number") {
      setPhase({ kind: "error", message: "sceneId manquant — impossible de régénérer" });
      return;
    }
    setPhase({ kind: "regenerating" });
    try {
      const res = await fetch(`/api/projects/${slug}/regenerate-clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId: clip.sceneId, prompt, mode: "ingredients" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const data = await res.json() as { outputUrl: string };
      setPhase({ kind: "regenerated", newUrl: data.outputUrl });
      // Bust the video cache by adding a timestamp query string.
      const cacheBustedUrl = `${data.outputUrl}?t=${Date.now()}`;
      onClipUpdated({ ...clip, url: cacheBustedUrl, prompt });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const saveAndClose = () => {
    if (prompt !== (clip.prompt ?? "")) {
      onClipUpdated({ ...clip, prompt });
    }
    onClose();
  };

  const isBusy = phase.kind === "ai-rewriting" || phase.kind === "regenerating";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.88)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          // Solid panel — no backdrop transparency so text stays crisp over any background.
          background: "#171821",
          borderRadius: "var(--radius-lg)",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04) inset",
          color: "#f3f4f8",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", background: "#1d1f2a" }}>
          <div className="min-w-0 flex-1">
            <div className="mono-sm" style={{ color: "rgba(255,255,255,0.55)" }}>Scene · {clip.sceneId ?? "?"} · {(clip.durationInFrames / fps).toFixed(1)}s</div>
            <h3 className="heading-md text-[15px] truncate" style={{ color: "#f3f4f8" }}>{clip.label ?? "Sans titre"}</h3>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="flex items-center justify-center" style={{ width: 32, height: 32, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "rgba(255,255,255,0.85)" }}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Video preview */}
          <div style={{ background: "#000", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              key={clip.url}
              src={clip.url}
              controls
              playsInline
              className="w-full aspect-video"
              style={{ background: "#000" }}
            />
          </div>

          {/* Prompt editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="mono-sm" style={{ color: "rgba(255,255,255,0.7)" }}>Prompt vidéo</label>
              <span className="mono-sm" style={{ color: "rgba(255,255,255,0.45)" }}>
                {prompt.length} car · {prompt.split(/\s+/).filter(Boolean).length} mots
              </span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={14}
              className="w-full px-3 py-2.5 text-[12px] outline-none resize-y font-mono"
              style={{
                background: "#0e0f15",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#f3f4f8",
                lineHeight: 1.5,
              }}
              placeholder="Si le prompt original n'est pas trouvé, colle-le ou décris la scène ici. Format Veo3: Location / Main subject / Camera / Action / French dialogue / Mood / Style / Avoid."
              disabled={isBusy}
            />
          </div>

          {/* AI instructions */}
          <div className="space-y-2">
            <label className="mono-sm" style={{ color: "rgba(255,255,255,0.7)" }}>Instruction pour l&apos;IA (optionnelle)</label>
            <input
              type="text"
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              placeholder="Ex: rendre la scène plus émotionnelle, retirer les noms historiques, ajouter un détail visuel…"
              className="w-full px-3 py-2 text-[13px] outline-none"
              style={{
                background: "#0e0f15",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#f3f4f8",
              }}
              disabled={isBusy}
            />
          </div>

          {/* Status messages */}
          {phase.kind === "error" && (
            <div className="px-3 py-2 rounded-md text-[12px]" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
              {phase.message}
            </div>
          )}
          {phase.kind === "regenerated" && (
            <div className="px-3 py-2 rounded-md text-[12px]" style={{ background: "rgba(92,232,134,0.15)", color: "var(--green, #5ce886)" }}>
              Régénération OK — le clip a été remplacé dans la timeline.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 flex-wrap px-5 py-3" style={{ borderTop: "1px solid rgba(255,255,255,0.08)", background: "#1d1f2a" }}>
          <button
            onClick={runAiRewrite}
            disabled={isBusy || prompt.trim().length < 10}
            className="btn-glass"
            style={{ opacity: prompt.trim().length < 10 ? 0.5 : 1 }}
          >
            {phase.kind === "ai-rewriting"
              ? <><Loader2 size={13} className="animate-spin" /> Réécriture…</>
              : <><Sparkles size={13} /> Améliorer avec l&apos;IA</>}
          </button>
          <button
            onClick={runRegenerate}
            disabled={isBusy || prompt.trim().length < 10 || typeof clip.sceneId !== "number"}
            className="btn-primary"
            style={{ opacity: (prompt.trim().length < 10 || typeof clip.sceneId !== "number") ? 0.5 : 1 }}
          >
            {phase.kind === "regenerating"
              ? <><Loader2 size={13} className="animate-spin" /> Régénération… (~3-5 min)</>
              : <><RefreshCw size={13} /> Régénérer le clip</>}
          </button>
          <div className="flex-1" />
          <button
            onClick={saveAndClose}
            disabled={isBusy}
            className="btn-glass"
          >
            <Save size={13} />
            Enregistrer & fermer
          </button>
        </div>
      </div>
    </div>
  );
}
