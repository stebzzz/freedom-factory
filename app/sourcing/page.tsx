"use client";

import { useEffect, useState } from "react";
import { Search, Sparkles, Plus, X, Download, Loader2, Package, Folder, Wand2, AlertTriangle } from "lucide-react";
import { AssetGrid } from "@/components/sourcing/AssetGrid";
import type { SourcingAsset, DownloadTarget } from "@/lib/sourcing/types";

type Step = "input" | "queries" | "results" | "downloading" | "done";

interface ProjectListItem {
  slug: string;
  label: string;
}

interface PackListItem {
  slug: string;
  title: string;
  assetCount: number;
  imageCount: number;
  videoCount: number;
  updatedAt: number;
}

interface DownloadResult {
  ok: number;
  failed: Array<{ id: string; error: string }>;
  packSlug: string;
  outDir: string;
}

export default function SourcingPage() {
  const [step, setStep] = useState<Step>("input");
  const [title, setTitle] = useState("");
  const [hint, setHint] = useState("");
  const [queries, setQueries] = useState<string[]>([]);
  const [newQuery, setNewQuery] = useState("");
  const [assets, setAssets] = useState<SourcingAsset[]>([]);
  const [errors, setErrors] = useState<Array<{ provider: string; message: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [targetType, setTargetType] = useState<"pack" | "project">("pack");
  const [targetProject, setTargetProject] = useState<string>("");
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [packs, setPacks] = useState<PackListItem[]>([]);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);

  // Load projects + packs
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => {
        const list: ProjectListItem[] = (d.projects ?? []).map((p: { slug: string; label: string }) => ({ slug: p.slug, label: p.label }));
        setProjects(list);
        if (list.length > 0 && !targetProject) setTargetProject(list[0].slug);
      })
      .catch(() => {});
    fetch("/api/sourcing/packs")
      .then((r) => r.json())
      .then((d) => setPacks(d.packs ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateQueries = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/sourcing/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), hint: hint.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setQueries(data.queries ?? []);
      setStep("queries");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async () => {
    if (queries.length === 0) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/sourcing/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries, title, rankWithClaude: true, topN: 60 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAssets(data.assets ?? []);
      setErrors(data.errors ?? []);
      setSelected(new Set());
      setStep("results");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(assets.map((a) => a.id)));
  const selectNone = () => setSelected(new Set());

  const launchDownload = async () => {
    if (selected.size === 0) return;
    setBusy(true); setError(null); setStep("downloading");
    try {
      const target: DownloadTarget = targetType === "pack"
        ? { type: "pack", slug: title.trim() || "sourcing-pack" }
        : { type: "project", slug: targetProject };
      const selectedAssets = assets.filter((a) => selected.has(a.id));
      const res = await fetch("/api/sourcing/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, assets: selectedAssets, title, queries }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDownloadResult(data);
      // Refresh packs list.
      fetch("/api/sourcing/packs").then((r) => r.json()).then((d) => setPacks(d.packs ?? []));
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("results");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("input");
    setQueries([]);
    setAssets([]);
    setSelected(new Set());
    setErrors([]);
    setDownloadResult(null);
    setError(null);
  };

  return (
    <div className="space-y-8 animate-in pb-12">
      <header>
        <div className="mono-sm mb-2">Workspace · IA</div>
        <h1 className="heading-xl">Sourcing</h1>
        <p className="text-[14px] mt-2 max-w-2xl" style={{ color: "var(--text-secondary)" }}>
          Recherche automatique d&apos;archives photo/vidéo. Claude génère des queries depuis ton titre, scanne Pexels + Wikimedia + Pixabay + Unsplash, et classe les résultats. Tu sélectionnes ce qui te plaît, on télécharge.
        </p>
      </header>

      {/* === Step 1 : Input title === */}
      <section className="glass-static p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
            <Wand2 size={15} />
          </div>
          <div>
            <h2 className="heading-md text-[14px]">Sujet de la vidéo</h2>
            <div className="mono-sm">Claude générera 5–10 queries de recherche</div>
          </div>
        </div>

        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex : The 1900 Galveston Hurricane"
          className="w-full px-3 py-2.5 text-[15px] outline-none"
          style={inputStyle}
        />
        <textarea
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          rows={2}
          placeholder="(optionnel) Contexte additionnel : époque, lieu, ambiance, mots-clés à privilégier…"
          className="w-full px-3 py-2 text-[13px] outline-none resize-y"
          style={inputStyle}
        />

        <div className="flex items-center gap-2">
          <button
            onClick={generateQueries}
            disabled={title.trim().length < 3 || busy}
            className="btn-primary"
            style={{ opacity: title.trim().length < 3 || busy ? 0.5 : 1 }}
          >
            {busy && step === "input" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Générer les queries Claude
          </button>
          {queries.length > 0 && step === "input" && (
            <button onClick={() => setStep("queries")} className="btn-glass">
              Reprendre les queries actuelles ({queries.length})
            </button>
          )}
        </div>
      </section>

      {/* === Step 2 : Queries === */}
      {(step === "queries" || step === "results" || step === "downloading" || step === "done") && queries.length > 0 && (
        <section className="glass-static p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
              <Search size={15} />
            </div>
            <div>
              <h2 className="heading-md text-[14px]">Queries de recherche</h2>
              <div className="mono-sm">{queries.length} keyword{queries.length > 1 ? "s" : ""} · ajoutables/retirables</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {queries.map((q, i) => (
              <span
                key={`${q}-${i}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px]"
                style={{
                  background: "var(--accent-bg)",
                  color: "var(--accent)",
                  borderRadius: 100,
                  border: "1px solid var(--accent)",
                }}
              >
                {q}
                <button
                  onClick={() => setQueries(queries.filter((_, j) => j !== i))}
                  className="hover:opacity-100 opacity-60"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={newQuery}
              onChange={(e) => setNewQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newQuery.trim()) {
                  setQueries([...queries, newQuery.trim()]);
                  setNewQuery("");
                }
              }}
              placeholder="Ajouter une query manuelle…"
              className="flex-1 px-3 py-2 text-[13px] outline-none"
              style={inputStyle}
            />
            <button
              onClick={() => {
                if (newQuery.trim()) {
                  setQueries([...queries, newQuery.trim()]);
                  setNewQuery("");
                }
              }}
              className="btn-glass"
            >
              <Plus size={14} /> Ajouter
            </button>
            <button
              onClick={runSearch}
              disabled={queries.length === 0 || busy}
              className="btn-primary"
              style={{ opacity: queries.length === 0 || busy ? 0.5 : 1 }}
            >
              {busy && step === "queries" ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              Lancer la recherche
            </button>
          </div>
        </section>
      )}

      {/* Errors */}
      {error && (
        <div className="px-4 py-3 rounded-lg text-[13px] flex items-center gap-2" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* === Step 3 : Results === */}
      {(step === "results" || step === "downloading" || step === "done") && assets.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="heading-lg">Résultats</h2>
            {errors.length > 0 && (
              <span className="mono-sm" style={{ color: "var(--orange)" }}>
                {errors.length} provider{errors.length > 1 ? "s" : ""} en erreur
              </span>
            )}
          </div>

          <AssetGrid
            assets={assets}
            selectedIds={selected}
            onToggle={toggleSelect}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
          />
        </section>
      )}

      {/* === Step 4 : Download target + button === */}
      {(step === "results" || step === "downloading" || step === "done") && assets.length > 0 && (
        <section
          className="glass-strong p-5 space-y-4 sticky bottom-4"
          style={{ borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-lg)" }}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
              <Download size={15} />
            </div>
            <div className="flex-1">
              <h2 className="heading-md text-[14px]">Cible du téléchargement</h2>
              <div className="mono-sm">
                {selected.size === 0 ? "Aucune sélection" : `${selected.size} asset${selected.size > 1 ? "s" : ""} sélectionné${selected.size > 1 ? "s" : ""}`}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setTargetType("pack")}
              className="flex items-start gap-3 p-3 text-left transition-all"
              style={{
                background: targetType === "pack" ? "var(--accent-bg)" : "var(--bg-glass)",
                border: `1.5px solid ${targetType === "pack" ? "var(--accent)" : "var(--border-glass)"}`,
                borderRadius: "var(--radius-sm)",
              }}
            >
              <Package size={16} style={{ color: targetType === "pack" ? "var(--accent)" : "var(--text-secondary)" }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold">Pack indépendant</div>
                <div className="mono-sm">public/sourcing/{title ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "…" : "…"}</div>
              </div>
            </button>
            <button
              onClick={() => setTargetType("project")}
              className="flex items-start gap-3 p-3 text-left transition-all"
              style={{
                background: targetType === "project" ? "var(--accent-bg)" : "var(--bg-glass)",
                border: `1.5px solid ${targetType === "project" ? "var(--accent)" : "var(--border-glass)"}`,
                borderRadius: "var(--radius-sm)",
              }}
            >
              <Folder size={16} style={{ color: targetType === "project" ? "var(--accent)" : "var(--text-secondary)" }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold">Projet existant</div>
                <div className="mono-sm">public/generated/[projet]/archives/</div>
              </div>
            </button>
          </div>

          {targetType === "project" && (
            <select
              value={targetProject}
              onChange={(e) => setTargetProject(e.target.value)}
              className="w-full px-3 py-2.5 text-[14px] outline-none"
              style={inputStyle}
            >
              {projects.length === 0 ? (
                <option value="">— Aucun projet —</option>
              ) : (
                projects.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)
              )}
            </select>
          )}

          {step === "done" && downloadResult && (
            <div className="px-4 py-3 rounded-lg text-[13px] flex items-center gap-3" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
              <span className="font-semibold">{downloadResult.ok} OK</span>
              {downloadResult.failed.length > 0 && (
                <span style={{ color: "var(--red)" }}>· {downloadResult.failed.length} échec{downloadResult.failed.length > 1 ? "s" : ""}</span>
              )}
              <span className="mono-sm flex-1 truncate">{downloadResult.outDir}</span>
              <button onClick={reset} className="btn-glass" style={{ padding: "5px 12px", fontSize: 12 }}>Nouveau sourcing</button>
            </div>
          )}

          {step !== "done" && (
            <button
              onClick={launchDownload}
              disabled={selected.size === 0 || busy || (targetType === "project" && !targetProject)}
              className="btn-primary w-full justify-center"
              style={{ padding: "11px 18px", opacity: selected.size === 0 || busy || (targetType === "project" && !targetProject) ? 0.5 : 1 }}
            >
              {busy && step === "downloading" ? (
                <><Loader2 size={14} className="animate-spin" /> Téléchargement…</>
              ) : (
                <><Download size={14} /> Télécharger {selected.size > 0 ? `${selected.size} asset${selected.size > 1 ? "s" : ""}` : ""}</>
              )}
            </button>
          )}
        </section>
      )}

      {/* === Existing packs === */}
      {step === "input" && packs.length > 0 && (
        <section>
          <h2 className="heading-lg mb-4">Packs existants</h2>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {packs.map((p) => (
              <div key={p.slug} className="glass-static p-4">
                <div className="heading-md text-[14px] truncate">{p.title}</div>
                <div className="mono-sm mt-1">{p.slug}</div>
                <div className="flex gap-3 mt-3 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  <span><b>{p.assetCount}</b> assets</span>
                  <span>{p.imageCount} img</span>
                  <span>{p.videoCount} vid</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-glass-hover)",
  border: "1px solid var(--border-glass)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
};
