"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Trash2, User, Image as ImageIcon, ArrowRightLeft, Sparkles, Copy, Check, Download } from "lucide-react";
import { use } from "react";
import type { KitImage, KitMeta, KitTag } from "@/lib/style-kit/types";

export default function KitDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [kit, setKit] = useState<KitMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/style-kit/${slug}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setKit(data.kit);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  const retag = async (filename: string, nextTag: KitTag) => {
    setPendingFile(filename);
    try {
      const res = await fetch(`/api/style-kit/${slug}/retag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, tag: nextTag }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setKit(data.kit);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingFile(null);
    }
  };

  const removeImage = async (filename: string) => {
    if (!confirm(`Supprimer ${filename} ?`)) return;
    setPendingFile(filename);
    try {
      const res = await fetch(
        `/api/style-kit/${slug}/image?filename=${encodeURIComponent(filename)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setKit(data.kit);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingFile(null);
    }
  };

  if (loading && !kit) return <div className="glass-static py-16 text-center mono-sm">chargement…</div>;
  if (error && !kit)
    return (
      <div className="glass-static py-6 px-5" style={{ color: "var(--red)" }}>
        {error}
      </div>
    );
  if (!kit) return null;

  return (
    <div className="space-y-8 animate-in">
      <div>
        <Link
          href="/style-kit"
          className="inline-flex items-center gap-1.5 mono-sm mb-2"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={12} />
          Tous les kits
        </Link>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="heading-xl">{kit.slug}</h1>
          <div className="mono-sm">
            {kit.mode === "describe"
              ? `${kit.character.length + kit.style.length} prompts · mode describe`
              : `${kit.character.length} character · ${kit.style.length} style`}
            {" · importé "}
            {new Date(kit.createdAt).toLocaleDateString("fr-FR")}
            {kit.sourcePdf ? ` · depuis ${kit.sourcePdf}` : ""}
          </div>
        </div>
      </div>

      {error && (
        <div
          className="glass-static py-3 px-4 text-[13px]"
          style={{ color: "var(--red)" }}
        >
          {error}
        </div>
      )}

      {kit.styleBrief && (
        <section className="glass-static p-5">
          <div className="flex items-start gap-3 mb-3">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
              style={{ background: "var(--accent-bg)", color: "var(--green)" }}
            >
              <Sparkles size={15} />
            </div>
            <div className="flex-1">
              <h3 className="heading-md text-[14px]">Style brief (auto)</h3>
              <div className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                Consolidé par Claude Sonnet depuis l&apos;analyse Haiku Vision de chaque frame. Auto-injecté comme suffix de prompt sur chaque image générée si tu sélectionnes ce kit dans /pipeline.
              </div>
            </div>
          </div>
          <pre
            className="text-[12px] whitespace-pre-wrap px-3 py-2.5"
            style={{
              background: "var(--bg-glass-hover)",
              border: "1px solid var(--border-glass)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono), monospace",
              lineHeight: 1.55,
            }}
          >
            {kit.styleBrief}
          </pre>
        </section>
      )}

      {kit.mode === "describe" ? (
        <PromptList
          slug={kit.slug}
          images={[...kit.character, ...kit.style]}
          pendingFile={pendingFile}
          onDelete={removeImage}
        />
      ) : (
        <>
          <Bucket
            title="Character"
            subtitle="Refs avec stickman / personnage — injectées dans les scènes mentionnant un humain"
            icon={User}
            images={kit.character}
            otherTag="style"
            pendingFile={pendingFile}
            onRetag={retag}
            onDelete={removeImage}
          />
          <Bucket
            title="Style"
            subtitle="Refs décor / palette / composition — injectées dans toutes les scènes"
            icon={ImageIcon}
            images={kit.style}
            otherTag="character"
            pendingFile={pendingFile}
            onRetag={retag}
            onDelete={removeImage}
          />
        </>
      )}
    </div>
  );
}

function PromptList({
  slug,
  images,
  pendingFile,
  onDelete,
}: {
  slug: string;
  images: KitImage[];
  pendingFile: string | null;
  onDelete: (filename: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyAllState, setCopyAllState] = useState<"idle" | "copied">("idle");

  const copy = async (filename: string, prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(filename);
      setTimeout(() => setCopied((c) => (c === filename ? null : c)), 1500);
    } catch {
      /* ignore */
    }
  };

  const copyAllJson = async () => {
    try {
      const res = await fetch(`/api/style-kit/${slug}/prompts`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopyAllState("copied");
      setTimeout(() => setCopyAllState("idle"), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <section>
      <div className="flex items-start gap-3 mb-4">
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
          style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
        >
          <ImageIcon size={15} />
        </div>
        <div className="flex-1">
          <h2 className="heading-md text-[14px]">
            Images <span className="mono-sm ml-1">({images.length})</span>
          </h2>
          <div className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            Mode describe — chaque image a un prompt image-gen détaillé généré par Haiku Vision.
          </div>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            onClick={copyAllJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--bg-glass)",
              border: "1px solid var(--border-glass)",
              borderRadius: "var(--radius-sm)",
              color: copyAllState === "copied" ? "var(--green)" : "var(--text-secondary)",
            }}
            title="Copier tout le JSON dans le presse-papier"
          >
            {copyAllState === "copied" ? <Check size={12} /> : <Copy size={12} />}
            {copyAllState === "copied" ? "Copié" : "Copier JSON"}
          </button>
          <a
            href={`/api/style-kit/${slug}/prompts?download=1`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--accent)",
              borderRadius: "var(--radius-sm)",
              color: "white",
            }}
            title="Télécharger le JSON des prompts"
          >
            <Download size={12} />
            Télécharger JSON
          </a>
        </div>
      </div>

      {images.length === 0 ? (
        <div className="glass-static py-8 text-center mono-sm">
          Aucune image dans ce kit.
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr" }}>
          {images.map((img) => {
            const isPending = pendingFile === img.filename;
            const prompt = img.imagePrompt?.trim() || img.label || "(prompt manquant)";
            const isCopied = copied === img.filename;
            return (
              <div
                key={img.filename}
                className="glass-static p-3 flex gap-3"
                style={{ opacity: isPending ? 0.4 : 1 }}
              >
                <div
                  className="flex-shrink-0 rounded-lg bg-cover bg-center"
                  style={{
                    width: 180,
                    height: 180,
                    background: `url(${img.url}) center/cover, var(--bg-glass)`,
                  }}
                />
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="mono-sm truncate">{img.filename}</div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => copy(img.filename, prompt)}
                        disabled={isPending || !img.imagePrompt}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium"
                        style={{
                          background: "var(--bg-glass)",
                          border: "1px solid var(--border-glass)",
                          borderRadius: "var(--radius-sm)",
                          color: isCopied ? "var(--green)" : "var(--text-secondary)",
                        }}
                        title="Copier le prompt"
                      >
                        {isCopied ? <Check size={11} /> : <Copy size={11} />}
                        {isCopied ? "Copié" : "Copier"}
                      </button>
                      <button
                        onClick={() => onDelete(img.filename)}
                        disabled={isPending}
                        className="inline-flex items-center justify-center px-2 py-1"
                        style={{
                          background: "var(--bg-glass)",
                          border: "1px solid var(--border-glass)",
                          borderRadius: "var(--radius-sm)",
                          color: "var(--red)",
                        }}
                        title="Supprimer cette image"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                  <pre
                    className="text-[12px] whitespace-pre-wrap flex-1 px-3 py-2 overflow-auto"
                    style={{
                      background: "var(--bg-glass-hover)",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "var(--radius-sm)",
                      fontFamily: "var(--font-mono), monospace",
                      lineHeight: 1.5,
                    }}
                  >
                    {prompt}
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Bucket({
  title,
  subtitle,
  icon: Icon,
  images,
  otherTag,
  pendingFile,
  onRetag,
  onDelete,
}: {
  title: string;
  subtitle: string;
  icon: typeof User;
  images: KitImage[];
  otherTag: KitTag;
  pendingFile: string | null;
  onRetag: (filename: string, nextTag: KitTag) => void;
  onDelete: (filename: string) => void;
}) {
  return (
    <section>
      <div className="flex items-start gap-3 mb-4">
        <div
          className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
          style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
        >
          <Icon size={15} />
        </div>
        <div className="flex-1">
          <h2 className="heading-md text-[14px]">
            {title} <span className="mono-sm ml-1">({images.length})</span>
          </h2>
          <div className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            {subtitle}
          </div>
        </div>
      </div>

      {images.length === 0 ? (
        <div className="glass-static py-8 text-center mono-sm">
          Aucune image dans ce bucket — utilise &laquo; déplacer &raquo; sur une image de l&apos;autre catégorie.
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
        >
          {images.map((img) => {
            const isPending = pendingFile === img.filename;
            return (
              <div
                key={img.filename}
                className="glass-static overflow-hidden group"
                style={{ opacity: isPending ? 0.4 : 1 }}
              >
                <div
                  className="aspect-square bg-cover bg-center"
                  style={{ background: `url(${img.url}) center/cover, var(--bg-glass)` }}
                />
                <div className="p-2.5 space-y-1.5">
                  <div className="text-[11px] truncate" title={img.label}>
                    {img.label || img.filename}
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => onRetag(img.filename, otherTag)}
                      disabled={isPending}
                      className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] font-medium"
                      style={{
                        background: "var(--bg-glass)",
                        border: "1px solid var(--border-glass)",
                        borderRadius: "var(--radius-sm)",
                        color: "var(--text-secondary)",
                      }}
                      title={`Déplacer vers ${otherTag}`}
                    >
                      <ArrowRightLeft size={10} />
                      {otherTag}
                    </button>
                    <button
                      onClick={() => onDelete(img.filename)}
                      disabled={isPending}
                      className="inline-flex items-center justify-center px-2 py-1"
                      style={{
                        background: "var(--bg-glass)",
                        border: "1px solid var(--border-glass)",
                        borderRadius: "var(--radius-sm)",
                        color: "var(--red)",
                      }}
                      title="Supprimer cette image"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
