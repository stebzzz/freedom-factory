"use client";

import { useEffect, useState } from "react";
import { X, Save, RotateCcw, Image as ImageIcon, Sparkles } from "lucide-react";
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
  const [busy, setBusy] = useState<null | "save" | "regen" | "rewrite">(null);
  const [error, setError] = useState<string | null>(null);
  // bumped after each regen to cache-bust the <img>
  const [imgRev, setImgRev] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (scene) {
      setVideoPrompt(scene.videoPrompt ?? "");
      setImagePrompt(scene.imagePrompt ?? "");
      setVo(scene.vo ?? "");
      setError(null);
      setImgRev(0);
      setPreviewUrl(scene.imageUrl);
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
    setBusy(regen ? "regen" : "save");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPrompt,
          imagePrompt: kind === "i2v" ? imagePrompt : imagePrompt,
          vo,
          regen,
          mode,
        }),
      });
      const data = (await res.json()) as { error?: string; regenError?: string; imageUrl?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.regenError) throw new Error(data.regenError);
      onSaved();
      if (regen) {
        // Replace the live preview with the freshly regenerated image. Cache-bust by bumping
        // imgRev so the browser fetches the new bytes from the same URL.
        if (data.imageUrl) setPreviewUrl(data.imageUrl);
        setImgRev((r) => r + 1);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rewriteFromVO = async () => {
    if (!vo.trim()) {
      setError("Voice-over vide — écris quelque chose avant de réécrire le prompt");
      return;
    }
    setBusy("rewrite");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/scenes/${scene.id}/rewrite-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vo, currentPrompt: imagePrompt }),
      });
      const data = (await res.json()) as { imagePrompt?: string; error?: string };
      if (!res.ok || !data.imagePrompt) throw new Error(data.error ?? `HTTP ${res.status}`);
      setImagePrompt(data.imagePrompt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cacheBustedPreview = previewUrl ? `${previewUrl}${previewUrl.includes("?") ? "&" : "?"}v=${imgRev}` : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(6px)",
        animation: "fadeIn 0.18s ease-out",
      }}
      onClick={onClose}
    >
      <div
        className="relative flex flex-col overflow-hidden"
        style={{
          width: "min(1100px, 100%)",
          maxHeight: "calc(100vh - 48px)",
          background: "var(--bg-primary)",
          border: "1px solid var(--border-glass-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: "1px solid var(--border-glass)" }}
        >
          <div className="flex items-center gap-3">
            <span className="mono-sm">#{String(scene.id).padStart(3, "0")}</span>
            <StatusBadge status={scene.status} />
            {scene.videoAttempt && scene.videoAttempt > 1 && (
              <span className="mono-sm">attempt {scene.videoAttempt}</span>
            )}
            <span className="heading-md ml-2">{scene.title || scene.section || `Scene ${scene.id}`}</span>
          </div>
          <button onClick={onClose} className="btn-glass" style={{ padding: 6 }} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* Body — 2 columns: preview / prompts */}
        <div
          className="grid gap-6 px-6 py-5 overflow-y-auto"
          style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}
        >
          {/* Left — preview + voice over */}
          <div className="space-y-4">
            <div
              className="relative w-full"
              style={{
                aspectRatio: "16 / 9",
                background: "black",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                border: "1px solid var(--border-glass)",
              }}
            >
              {scene.clipUrl ? (
                <video
                  src={scene.clipUrl}
                  controls
                  className="w-full h-full"
                  style={{ objectFit: "cover" }}
                />
              ) : cacheBustedPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={cacheBustedPreview}
                  alt=""
                  className="w-full h-full"
                  style={{ objectFit: "cover" }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center mono-sm" style={{ opacity: 0.6 }}>
                  Pas encore d&apos;image
                </div>
              )}
              {busy === "regen" && (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: "rgba(0,0,0,0.55)" }}
                >
                  <span className="mono-sm" style={{ color: "white" }}>
                    Génération en cours…
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="mono-sm block">Voice-over</label>
              <textarea
                value={vo}
                onChange={(e) => setVo(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-[13px] outline-none resize-y"
                style={{
                  background: "var(--bg-glass-hover)",
                  border: "1px solid var(--border-glass)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            {(scene.videoError || scene.imageError) && (
              <div
                className="text-[12px] px-3 py-2 rounded-lg"
                style={{ background: "var(--red-bg)", color: "var(--red)" }}
              >
                {scene.videoError || scene.imageError}
              </div>
            )}
          </div>

          {/* Right — prompts */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="mono-sm block">Image prompt</label>
                <button
                  onClick={rewriteFromVO}
                  disabled={busy !== null}
                  className="btn-glass"
                  style={{ padding: "4px 10px", fontSize: 11, opacity: busy !== null ? 0.5 : 1 }}
                  title="Réécrit l'image prompt depuis la voice-over via Claude"
                >
                  <Sparkles size={12} />
                  {busy === "rewrite" ? "…" : "Rewrite from VO"}
                </button>
              </div>
              <textarea
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                rows={6}
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
              <div className="mono-sm" style={{ textAlign: "right" }}>
                {imagePrompt.length} chars
              </div>
            </div>

            {kind !== "static-images" && (
              <div className="space-y-2">
                <label className="mono-sm block">
                  {kind === "i2v" ? "Animation prompt" : "Video prompt"}
                </label>
                <textarea
                  value={videoPrompt}
                  onChange={(e) => setVideoPrompt(e.target.value)}
                  rows={6}
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
                <div className="mono-sm" style={{ textAlign: "right" }}>
                  {videoPrompt.length} chars
                </div>
              </div>
            )}

            {error && (
              <div
                className="text-[12px] px-3 py-2 rounded-lg"
                style={{ background: "var(--red-bg)", color: "var(--red)" }}
              >
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div
          className="flex flex-wrap items-center justify-end gap-2 px-6 py-4"
          style={{ borderTop: "1px solid var(--border-glass)" }}
        >
          <button onClick={onClose} className="btn-glass" disabled={busy !== null}>
            Fermer
          </button>
          <button
            onClick={() => submit(false)}
            disabled={!dirty || busy !== null}
            className="btn-glass"
            style={{ opacity: !dirty || busy !== null ? 0.5 : 1 }}
          >
            <Save size={14} />
            Save
          </button>
          <button
            onClick={() => submit(true, "scene-regen-image")}
            disabled={busy !== null}
            className="btn-primary"
            style={{ opacity: busy !== null ? 0.5 : 1 }}
          >
            <ImageIcon size={14} />
            {busy === "regen" ? "Génération…" : dirty ? "Save & regen image" : "Regen image"}
          </button>
          {kind !== "static-images" && scene.imageUrl && (
            <button
              onClick={() => submit(true, "scene-regen-video")}
              disabled={busy !== null}
              className="btn-glass"
              style={{ opacity: busy !== null ? 0.5 : 1 }}
              title="Regen le clip vidéo à partir de l'image existante"
            >
              <RotateCcw size={14} />
              Regen video
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
