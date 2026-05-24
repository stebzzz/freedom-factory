"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Film, Trash2, CheckCircle2 } from "lucide-react";

interface Props {
  slug: string;
  onAction: () => void;
}

export function PipelineFinalizePanel({ slug, onAction }: Props) {
  const [voPresent, setVoPresent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "delete" | "finalize">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/projects/${slug}/voiceover`)
      .then((r) => r.json())
      .then((d) => setVoPresent(!!d.exists))
      .catch(() => setVoPresent(false));
  }, [slug]);

  const uploadVo = async (file: File) => {
    setBusy("upload");
    setError(null);
    setInfo(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${slug}/voiceover`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setVoPresent(true);
      setInfo(`Voice-over uploadé (${Math.round((data.sizeBytes ?? 0) / 1024)} KB)`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const deleteVo = async () => {
    setBusy("delete");
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/projects/${slug}/voiceover`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setVoPresent(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const finalize = async () => {
    setBusy("finalize");
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/projects/${slug}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitles: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInfo(`master.mp4 prêt (${Math.round((data.fileSize ?? 0) / 1024 / 1024)} MB, ${Math.round(data.durationSeconds ?? 0)}s)`);
      onAction();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="glass-static p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="heading-md">Finaliser le job</div>
          <div className="mono-sm" style={{ opacity: 0.7 }}>
            Upload une voix off (wav/mp3/m4a) puis assemble le montage final.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {voPresent === true && (
            <span className="mono-sm inline-flex items-center gap-1" style={{ color: "var(--green)" }}>
              <CheckCircle2 size={14} /> voiceover.wav présent
            </span>
          )}
          {voPresent === false && (
            <span className="mono-sm" style={{ opacity: 0.6 }}>aucun voiceover</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".wav,.mp3,.m4a,.aac,.ogg,.flac,audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadVo(f);
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy !== null}
          className="btn-glass"
          style={{ opacity: busy !== null ? 0.5 : 1 }}
        >
          <Upload size={14} />
          {busy === "upload" ? "Upload…" : voPresent ? "Remplacer la VO" : "Uploader une VO"}
        </button>

        {voPresent && (
          <button
            onClick={deleteVo}
            disabled={busy !== null}
            className="btn-glass"
            style={{ opacity: busy !== null ? 0.5 : 1, color: "var(--red)" }}
          >
            <Trash2 size={14} />
            {busy === "delete" ? "…" : "Supprimer"}
          </button>
        )}

        <div className="w-px h-6" style={{ background: "var(--border-glass)" }} />

        <button
          onClick={finalize}
          disabled={busy !== null || !voPresent}
          className="btn-primary"
          title={voPresent ? "Assemble images + clips + voiceover → master.mp4" : "Uploade une VO d'abord"}
          style={{ opacity: busy !== null || !voPresent ? 0.5 : 1 }}
        >
          <Film size={14} />
          {busy === "finalize" ? "Montage en cours…" : "Finaliser → master.mp4"}
        </button>
      </div>

      {error && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
          {error}
        </div>
      )}
      {info && (
        <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)" }}>
          {info}
        </div>
      )}
    </div>
  );
}
