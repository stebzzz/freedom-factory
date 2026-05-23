"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Brush, Upload, FileText, Loader2, Trash2, ArrowRight, CheckCircle2, Clapperboard, Sparkles, Tags, ScrollText } from "lucide-react";
import type { KitMode, KitSummary } from "@/lib/style-kit/types";

const inputStyle: React.CSSProperties = {
  background: "var(--bg-glass-hover)",
  border: "1px solid var(--border-glass)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
};

type ImportMode = "pdf" | "youtube";

export default function StyleKitPage() {
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ImportMode>("youtube");
  const [kitMode, setKitMode] = useState<KitMode>("classify");
  const [slug, setSlug] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [cadenceSeconds, setCadenceSeconds] = useState(3);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/style-kit");
      const data = await res.json();
      if (Array.isArray(data?.kits)) setKits(data.kits);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const canSubmit = mode === "pdf" ? !!(pdf && slug.trim()) : !!(videoUrl.trim() && slug.trim());

  const submit = async () => {
    if (!canSubmit) return;
    setImporting(true);
    setError(null);
    try {
      let res: Response;
      if (mode === "pdf") {
        const fd = new FormData();
        fd.append("pdf", pdf!, pdf!.name);
        fd.append("slug", slug.trim());
        fd.append("mode", kitMode);
        res = await fetch("/api/style-kit/import-pdf", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/style-kit/import-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: videoUrl.trim(), slug: slug.trim(), cadenceSeconds, mode: kitMode }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.kit?.truncated && data.kit?.expectedCount) {
        setError(
          `Vidéo trop longue à cette cadence : ${data.kit.expectedCount} frames attendus, capé à 300. Augmente la cadence (ex: ${Math.ceil((data.kit.expectedCount / 300) * cadenceSeconds)}s) pour tout couvrir.`,
        );
      }
      setSlug("");
      setPdf(null);
      setVideoUrl("");
      if (fileRef.current) fileRef.current.value = "";
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const remove = async (kitSlug: string) => {
    if (!confirm(`Supprimer le kit '${kitSlug}' ?`)) return;
    await fetch(`/api/style-kit/${kitSlug}`, { method: "DELETE" });
    await reload();
  };

  return (
    <div className="space-y-8 animate-in">
      <header>
        <div className="mono-sm mb-2">Workspace · Réf visuelles</div>
        <h1 className="heading-xl">Style Kit</h1>
        <p className="text-[14px] mt-2 max-w-2xl" style={{ color: "var(--text-secondary)" }}>
          Importe un PDF moodboard, le pipeline en extrait les images et les classe en{" "}
          <strong>character</strong> (refs avec personnage) vs <strong>style</strong> (décors,
          palettes). Utilisable comme refs sur n&apos;importe quel run depuis /pipeline.
        </p>
      </header>

      <section className="glass-static p-5">
        <div className="flex items-start gap-3 mb-4">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
            style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
          >
            <Upload size={15} />
          </div>
          <div className="flex-1">
            <h3 className="heading-md text-[14px]">Importer un kit</h3>
            <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
              Depuis une vidéo YouTube (10 keyframes + style brief Sonnet) ou depuis un PDF moodboard.
            </div>
          </div>
        </div>

        <div className="flex gap-1 mb-4 p-1 w-fit" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
          <button
            onClick={() => setMode("youtube")}
            disabled={importing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-all"
            style={{
              background: mode === "youtube" ? "var(--accent)" : "transparent",
              color: mode === "youtube" ? "white" : "var(--text-secondary)",
              borderRadius: "calc(var(--radius-sm) - 2px)",
            }}
          >
            <Clapperboard size={13} />
            YouTube
          </button>
          <button
            onClick={() => setMode("pdf")}
            disabled={importing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-all"
            style={{
              background: mode === "pdf" ? "var(--accent)" : "transparent",
              color: mode === "pdf" ? "white" : "var(--text-secondary)",
              borderRadius: "calc(var(--radius-sm) - 2px)",
            }}
          >
            <FileText size={13} />
            PDF
          </button>
        </div>

        <div className="mb-4">
          <div className="mono-sm mb-1.5" style={{ color: "var(--text-secondary)" }}>
            Traitement par image
          </div>
          <div className="flex gap-1 p-1 w-fit" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
            <button
              onClick={() => setKitMode("classify")}
              disabled={importing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-all"
              style={{
                background: kitMode === "classify" ? "var(--accent)" : "transparent",
                color: kitMode === "classify" ? "white" : "var(--text-secondary)",
                borderRadius: "calc(var(--radius-sm) - 2px)",
              }}
              title="Sépare character vs style + style brief consolidé"
            >
              <Tags size={13} />
              Classify (char / style)
            </button>
            <button
              onClick={() => setKitMode("describe")}
              disabled={importing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-all"
              style={{
                background: kitMode === "describe" ? "var(--accent)" : "transparent",
                color: kitMode === "describe" ? "white" : "var(--text-secondary)",
                borderRadius: "calc(var(--radius-sm) - 2px)",
              }}
              title="Pas de tri — chaque image reçoit un prompt image-gen détaillé"
            >
              <ScrollText size={13} />
              Describe (image prompt par image)
            </button>
          </div>
          <div className="text-[11px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>
            {kitMode === "classify"
              ? "Classique : Haiku trie chaque image en character/style, et un brief consolidé est généré (YouTube)."
              : "Chaque image reçoit un prompt image-gen détaillé (90-140 mots). Pas de tri, pas de styleBrief consolidé."}
          </div>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="Nom du kit (ex: galveston-2d)"
            className="px-3 py-2.5 text-[14px] outline-none"
            style={inputStyle}
            disabled={importing}
          />
          {mode === "pdf" ? (
            <label
              className="flex items-center gap-2 px-3 py-2.5 cursor-pointer text-[13px]"
              style={inputStyle}
            >
              <FileText size={14} style={{ color: "var(--text-secondary)" }} />
              <span className="flex-1 truncate" style={{ color: pdf ? "var(--text-primary)" : "var(--text-tertiary)" }}>
                {pdf?.name ?? "Choisir un PDF…"}
              </span>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
                disabled={importing}
              />
            </label>
          ) : (
            <input
              type="url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
              className="px-3 py-2.5 text-[13px] outline-none font-mono"
              style={inputStyle}
              spellCheck={false}
              disabled={importing}
            />
          )}
          <button
            onClick={submit}
            disabled={!canSubmit || importing}
            className="btn-primary"
            style={{ padding: "11px 18px", opacity: !canSubmit || importing ? 0.5 : 1 }}
          >
            {importing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Import…
              </>
            ) : (
              <>
                <Upload size={14} />
                Importer
              </>
            )}
          </button>
        </div>
        {mode === "youtube" && (
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <label className="mono-sm" style={{ color: "var(--text-secondary)" }}>
              Cadence d&apos;extraction (sec)
            </label>
            <input
              type="number"
              min={0.5}
              max={60}
              step={0.5}
              value={cadenceSeconds}
              onChange={(e) => setCadenceSeconds(Math.max(0.5, Math.min(60, parseFloat(e.target.value) || 3)))}
              className="px-2 py-1 text-[13px] outline-none font-mono"
              style={{ ...inputStyle, width: 80 }}
              disabled={importing}
            />
            <span className="mono-sm" style={{ color: "var(--text-tertiary)" }}>
              1 frame toutes les {cadenceSeconds}s · max 300 frames (clamp si vid&eacute;o trop longue)
            </span>
          </div>
        )}
        {error && (
          <div
            className="mt-3 px-4 py-3 rounded-lg text-[13px]"
            style={{ background: "var(--red-bg)", color: "var(--red)" }}
          >
            {error}
          </div>
        )}
        {importing && mode === "youtube" && (
          <div className="mono-sm mt-3" style={{ color: "var(--text-secondary)" }}>
            yt-dlp 360p + ffmpeg fps=1/{cadenceSeconds} + Haiku Vision parall&egrave;le (×10) + Sonnet consolidate — selon dur&eacute;e source, compte 1-5 min.
          </div>
        )}
        {importing && mode === "pdf" && (
          <div className="mono-sm mt-3" style={{ color: "var(--text-secondary)" }}>
            Extraction + tagging Haiku par image — patience, ~1s par image extraite.
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="heading-lg">Kits disponibles</h2>
          <span className="mono-sm">
            {kits.length} kit{kits.length !== 1 ? "s" : ""}
          </span>
        </div>

        {loading ? (
          <div className="glass-static py-12 text-center mono-sm">chargement…</div>
        ) : kits.length === 0 ? (
          <div className="glass-static py-12 text-center mono-sm">
            Aucun kit pour l&apos;instant — importe un PDF ci-dessus.
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
          >
            {kits.map((k) => (
              <div key={k.slug} className="glass-static overflow-hidden group">
                <Link href={`/style-kit/${k.slug}`} className="block">
                  <div
                    className="aspect-[16/10] bg-cover bg-center"
                    style={{
                      background: k.previewUrl
                        ? `url(${k.previewUrl}) center/cover`
                        : "var(--bg-glass)",
                    }}
                  >
                    {!k.previewUrl && (
                      <div className="w-full h-full flex items-center justify-center">
                        <Brush size={32} style={{ color: "var(--text-tertiary)" }} />
                      </div>
                    )}
                  </div>
                </Link>
                <div className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] font-semibold truncate">{k.slug}</span>
                        {k.source === "youtube" && (
                          <Clapperboard size={11} style={{ color: "var(--accent)" }} />
                        )}
                        {k.hasStyleBrief && (
                          <span title="Style brief disponible — auto-injecté comme customStyle">
                            <Sparkles size={11} style={{ color: "var(--green)" }} />
                          </span>
                        )}
                        {k.mode === "describe" && (
                          <span title="Mode describe — chaque image a un prompt image-gen détaillé">
                            <ScrollText size={11} style={{ color: "var(--accent)" }} />
                          </span>
                        )}
                      </div>
                      <div className="mono-sm">
                        {k.mode === "describe"
                          ? `${k.characterCount + k.styleCount} prompts`
                          : `${k.characterCount} char · ${k.styleCount} style`}
                      </div>
                    </div>
                    <button
                      onClick={() => remove(k.slug)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Supprimer ce kit"
                    >
                      <Trash2 size={14} style={{ color: "var(--red)" }} />
                    </button>
                  </div>
                  <Link
                    href={`/style-kit/${k.slug}`}
                    className="flex items-center gap-1.5 text-[12px] font-medium"
                    style={{ color: "var(--accent)" }}
                  >
                    Voir le détail <ArrowRight size={11} />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="glass-static p-5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 size={14} style={{ color: "var(--green)" }} />
          <span className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
            Comment le pipeline utilise ce kit
          </span>
        </div>
        <ul className="space-y-1 pl-5 list-disc">
          <li>Page /pipeline → dropdown &laquo; Style kit &raquo; → choisis ton kit ; ça remplace l&apos;upload manuel.</li>
          <li>
            Pour chaque scène, le runner regarde le prompt image : s&apos;il contient stickman/human/hand/person… → injecte
            1 char + 4 style refs ; sinon 5 style refs uniquement.
          </li>
          <li>Évite la pollution &laquo; stickies fantômes &raquo; sur les scènes objets/paysages.</li>
        </ul>
      </section>
    </div>
  );
}
