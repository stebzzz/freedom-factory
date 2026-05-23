"use client";

import { useMemo, useState } from "react";
import type { SourcingAsset, AssetKind, Provider } from "@/lib/sourcing/types";
import { AssetCard } from "./AssetCard";

const PROVIDERS: Provider[] = ["pexels", "wikimedia", "pixabay", "unsplash"];

interface Props {
  assets: SourcingAsset[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}

export function AssetGrid({ assets, selectedIds, onToggle, onSelectAll, onSelectNone }: Props) {
  const [kindFilter, setKindFilter] = useState<"all" | AssetKind>("all");
  const [providerFilter, setProviderFilter] = useState<"all" | Provider>("all");

  const counts = useMemo(() => {
    const c = { total: assets.length, image: 0, video: 0, providers: {} as Record<string, number> };
    for (const a of assets) {
      c[a.kind]++;
      c.providers[a.provider] = (c.providers[a.provider] ?? 0) + 1;
    }
    return c;
  }, [assets]);

  const filtered = useMemo(() => {
    return assets.filter((a) => {
      if (kindFilter !== "all" && a.kind !== kindFilter) return false;
      if (providerFilter !== "all" && a.provider !== providerFilter) return false;
      return true;
    });
  }, [assets, kindFilter, providerFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={kindFilter === "all"} onClick={() => setKindFilter("all")} label={`Tout · ${counts.total}`} />
        <FilterChip active={kindFilter === "image"} onClick={() => setKindFilter("image")} label={`Images · ${counts.image}`} />
        <FilterChip active={kindFilter === "video"} onClick={() => setKindFilter("video")} label={`Vidéos · ${counts.video}`} />
        <div className="w-px h-5" style={{ background: "var(--border-glass)" }} />
        <FilterChip active={providerFilter === "all"} onClick={() => setProviderFilter("all")} label="Tous providers" />
        {PROVIDERS.map((p) => (
          <FilterChip
            key={p}
            active={providerFilter === p}
            onClick={() => setProviderFilter(p)}
            label={`${p} · ${counts.providers[p] ?? 0}`}
            disabled={!counts.providers[p]}
          />
        ))}

        <div className="flex-1" />

        <span className="mono-sm">{selectedIds.size} sélectionnés</span>
        <button onClick={onSelectAll} className="btn-glass" style={{ padding: "5px 12px", fontSize: 12 }}>
          Tout sélectionner
        </button>
        {selectedIds.size > 0 && (
          <button onClick={onSelectNone} className="btn-glass" style={{ padding: "5px 12px", fontSize: 12 }}>
            Désélectionner
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="glass-static py-12 text-center mono-sm">Aucun asset</div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {filtered.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              selected={selectedIds.has(asset.id)}
              onToggle={() => onToggle(asset.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label, disabled }: { active: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={active ? "btn-primary" : "btn-glass"}
      style={{ padding: "5px 12px", fontSize: 12, opacity: disabled ? 0.4 : 1 }}
    >
      {label}
    </button>
  );
}
