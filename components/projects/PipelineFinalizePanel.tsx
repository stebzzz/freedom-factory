"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Film, Trash2, CheckCircle2, Scissors } from "lucide-react";

interface Props {
  slug: string;
  onAction: () => void;
}

export function PipelineFinalizePanel({ slug, onAction }: Props) {
  const [voPresent, setVoPresent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "delete" | "finalize" | "clean">(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${slug}/voiceover`)
      .then((r) => r.json())
      .then((d) => setVoPresent(!!d.exists))
      .catch(() => setVoPresent(false));

    // Check whether a finalize is already running server-side (in case the user
    // refreshed the page or the previous fetch was cut short by a proxy timeout).
    fetch(`/api/projects/${slug}/finalize`)
      .then((r) => r.json())
      .then((d) => {
        if (d.running) {
          setBusy("finalize");
          setInfo("Un montage est déjà en cours côté serveur, on attend…");
          startPolling(d.startedAt);
        }
      })
      .catch(() => {});

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Poll the server every 5s while a finalize is running, so we don't depend on
  // the original POST staying open (Traefik will cut idle proxy after ~60s).
  const startPolling = (startedAt?: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const t0 = startedAt ?? Date.now();
    pollRef.current = setInterval(async () => {
      setElapsedSec(Math.floor((Date.now() - t0) / 1000));
      try {
        const r = await fetch(`/api/projects/${slug}/finalize`);
        const d = await r.json();
        if (!d.running) {
          stopPolling();
          setBusy(null);
          setInfo("Montage terminé — refresh pour voir le master.mp4");
          onAction();
        }
      } catch {
        /* network blip — keep polling */
      }
    }, 5000);
  };
  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setElapsedSec(0);
  };

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

  const cleanSilences = async () => {
    setBusy("clean");
    setError(null);
    setInfo("Nettoyage des silences en cours…");
    try {
      const res = await fetch(`/api/projects/${slug}/voiceover/clean-silences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: "-35dB", min: 0.4, pad: 0.08, fade: 0.02 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const removed = (data.removedSec ?? 0).toFixed(1);
      const before = (data.before?.durationSec ?? 0).toFixed(1);
      const after = (data.after?.durationSec ?? 0).toFixed(1);
      setInfo(`Silences retirés : ${before}s → ${after}s (-${removed}s). Original sauvegardé dans voiceover.original.wav.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const finalize = async () => {
    setBusy("finalize");
    setError(null);
    setInfo("Lancement du montage… (peut prendre plusieurs minutes)");
    const startedAt = Date.now();
    startPolling(startedAt);

    // Fire the POST. We don't await it strictly — the proxy may close the
    // connection at ~60s while ffmpeg keeps running server-side. The polling
    // loop above will detect completion via GET /finalize → running:false.
    try {
      const res = await fetch(`/api/projects/${slug}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitles: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        stopPolling();
        setBusy(null);
        setInfo(`master.mp4 prêt (${Math.round((data.fileSize ?? 0) / 1024 / 1024)} MB, ${Math.round(data.durationSeconds ?? 0)}s)`);
        onAction();
      } else if (res.status === 409 && data.running) {
        // Already running — polling above will pick up the completion.
        setInfo("Un montage est déjà en cours, on attend la fin…");
      } else if (!res.ok) {
        stopPolling();
        setBusy(null);
        setError(data.error ?? `HTTP ${res.status}`);
      }
    } catch {
      // Proxy/network closed the connection but server-side ffmpeg is still running.
      // Polling handles the rest.
      setInfo("La connexion au serveur a été coupée mais le montage continue côté serveur. On poll…");
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

        {voPresent && (
          <button
            onClick={cleanSilences}
            disabled={busy !== null}
            className="btn-glass"
            style={{ opacity: busy !== null ? 0.5 : 1 }}
            title="Détecte et raccourcit les silences > 0.4s (2-pass, micro-fade pour éviter les clicks). Original sauvegardé."
          >
            <Scissors size={14} />
            {busy === "clean" ? "Nettoyage…" : "Nettoyer silences"}
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
          {busy === "finalize"
            ? `Montage… ${elapsedSec ? `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}` : ""}`
            : "Finaliser → master.mp4"}
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
