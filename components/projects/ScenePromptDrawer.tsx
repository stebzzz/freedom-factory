"use client";

import { useEffect, useState } from "react";
import { X, Save, RotateCcw, Play } from "lucide-react";
import type { Scene, RunMode } from "@/lib/projects/types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  slug: string;
  scene: Scene | null;
  kind: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ScenePromptDrawer({ slug, scene, kind, onClose, onSaved }: Props) {
  const [videoPrompt, setVideoPrompt] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [vo, setVo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scene) {
      setVideoPrompt(scene.videoPrompt ?? "");
      setImagePrompt(scene.imagePrompt ?? "");
      setVo(scene.vo ?? "");
      setError(null);
    }
  }, [scene]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && scene) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scene, onClose]);

  if (!scene) return null;

  const dirty =
    videoPrompt !== (scene.videoPrompt ?? "") ||
    imagePrompt !== (scene.imagePrompt ?? "") ||
    vo !== (scene.vo ?? "");

  const submit = async (regen: boolean, mode: RunMode = "regen-ids") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPrompt,
          imagePrompt: kind === "i2v" ? imagePrompt : undefined,
          vo,
          regen,
          mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.regenError) throw new Error(data.regenError);
      onSaved();
      if (regen) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 backdrop-blur-sm" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose} />
      <div
        className="fixed top-0 right-0 bottom-0 z-50 overflow-y-auto"
        style={{
          width: "min(640px, 100vw)",
          background: "var(--bg-primary)",
          borderLeft: "1px solid var(--border-glass-strong)",
          boxShadow: "var(--shadow-lg)",
          animation: "fadeIn 0.25s ease-out",
        }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4" style={{ background: "var(--bg-primary)", borderBottom: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-3">
            <span className="mono-sm">#{String(scene.id).padStart(3, "0")}</span>
            <StatusBadge status={scene.status} />
            {scene.videoAttempt && scene.videoAttempt > 1 && <span className="mono-sm">attempt {scene.videoAttempt}</span>}
          </div>
          <button onClick={onClose} className="btn-glass" style={{ padding: 6 }}>
            <X size={14} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div>
            <h2 className="heading-md mb-1">{scene.title || scene.section || `Scene ${scene.id}`}</h2>
            {scene.section && scene.section !== scene.title && (
              <div className="mono-sm">{scene.section}</div>
            )}
          </div>

          {scene.clipUrl && (
            <video
              src={scene.clipUrl}
              controls
              className="w-full rounded-xl"
              style={{ aspectRatio: "16 / 9", background: "black", borderRadius: "var(--radius-sm)" }}
            />
          )}

          {scene.imageUrl && !scene.clipUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={scene.imageUrl} alt="" className="w-full rounded-xl" style={{ aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
          )}

          {(scene.videoError || scene.imageError) && (
            <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
              {scene.videoError || scene.imageError}
            </div>
          )}

          <div className="space-y-2">
            <label className="mono-sm block">Voice-over</label>
            <textarea
              value={vo}
              onChange={(e) => setVo(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-[13px] outline-none resize-y"
              style={{
                background: "var(--bg-glass-hover)",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          {kind === "i2v" && (
            <div className="space-y-2">
              <label className="mono-sm block">Image prompt</label>
              <textarea
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 text-[13px] font-mono outline-none resize-y"
                style={{
                  background: "var(--bg-glass-hover)",
                  border: "1px solid var(--border-glass)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="mono-sm block">{kind === "i2v" ? "Animation prompt" : "Video prompt"}</label>
            <textarea
              value={videoPrompt}
              onChange={(e) => setVideoPrompt(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 text-[13px] font-mono outline-none resize-y"
              style={{
                background: "var(--bg-glass-hover)",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            />
            <div className="mono-sm" style={{ textAlign: "right" }}>{videoPrompt.length} chars</div>
          </div>

          {error && (
            <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={() => submit(false)}
              disabled={!dirty || busy}
              className="btn-glass"
              style={{ opacity: !dirty || busy ? 0.5 : 1 }}
            >
              <Save size={14} />
              Save
            </button>
            <button
              onClick={() => submit(true, "regen-ids")}
              disabled={busy}
              className="btn-primary"
              style={{ opacity: busy ? 0.5 : 1 }}
            >
              <RotateCcw size={14} />
              {dirty ? "Save & regen" : "Regen"}
            </button>
            {kind === "i2v" && (
              <button
                onClick={() => submit(true, "scene-regen-image")}
                disabled={busy}
                className="btn-glass"
                style={{ opacity: busy ? 0.5 : 1 }}
              >
                <Play size={14} />
                Regen image
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
