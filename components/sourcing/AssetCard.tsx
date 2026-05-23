"use client";

import { useRef, useState } from "react";
import { Check, ExternalLink, Image as ImageIcon, Film } from "lucide-react";
import type { SourcingAsset } from "@/lib/sourcing/types";

const PROVIDER_COLORS: Record<string, string> = {
  pexels: "var(--green)",
  wikimedia: "var(--blue)",
  pixabay: "var(--accent)",
  unsplash: "var(--orange)",
};

interface Props {
  asset: SourcingAsset;
  selected: boolean;
  onToggle: () => void;
}

export function AssetCard({ asset, selected, onToggle }: Props) {
  const [hover, setHover] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const onEnter = () => {
    setHover(true);
    if (asset.kind === "video" && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };
  const onLeave = () => {
    setHover(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onToggle}
      className="group glass-static text-left overflow-hidden relative aspect-video w-full transition-all duration-200 cursor-pointer"
      style={{
        borderRadius: "var(--radius-sm)",
        border: selected ? "2px solid var(--accent)" : "1px solid var(--border-glass)",
      }}
    >
      {asset.kind === "video" ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={asset.thumbnailUrl} alt={asset.title || ""} className="absolute inset-0 w-full h-full object-cover" />
          {hover && asset.previewUrl && (
            <video
              ref={videoRef}
              src={asset.previewUrl}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.thumbnailUrl} alt={asset.title || ""} className="absolute inset-0 w-full h-full object-cover" />
      )}

      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 50%)" }}
      />

      {/* Provider chip */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5">
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: PROVIDER_COLORS[asset.provider] ?? "var(--text-tertiary)", boxShadow: `0 0 8px ${PROVIDER_COLORS[asset.provider] ?? "var(--text-tertiary)"}` }}
        />
        <span className="mono-sm text-white/80" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.6)" }}>
          {asset.provider}
        </span>
      </div>

      {/* Kind + score */}
      <div className="absolute top-2 right-2 flex items-center gap-1.5">
        {asset.rankScore !== undefined && (
          <span className="mono-sm text-white/85 px-1.5 py-0.5 rounded" style={{ background: "rgba(0,0,0,0.4)" }}>
            {Math.round(asset.rankScore)}
          </span>
        )}
        <div className="flex items-center justify-center w-5 h-5 rounded" style={{ background: "rgba(0,0,0,0.4)" }}>
          {asset.kind === "video" ? <Film size={10} color="white" /> : <ImageIcon size={10} color="white" />}
        </div>
      </div>

      {/* Selection checkbox */}
      <div
        className="absolute bottom-2 right-2 flex items-center justify-center transition-all"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: selected ? "var(--accent)" : "rgba(0,0,0,0.5)",
          border: selected ? "2px solid var(--accent)" : "2px solid rgba(255,255,255,0.5)",
        }}
      >
        {selected && <Check size={12} color="white" strokeWidth={3} />}
      </div>

      {/* Title + duration */}
      <div className="absolute bottom-0 left-0 right-12 px-2.5 py-2">
        <div className="text-[11px] text-white/95 leading-tight line-clamp-2" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.7)" }}>
          {asset.title || asset.author || `${asset.provider} ${asset.kind}`}
        </div>
        <div className="mono-sm text-white/55 mt-0.5">
          {asset.durationSec ? `${Math.round(asset.durationSec)}s · ` : ""}
          {asset.width && asset.height ? `${asset.width}×${asset.height}` : ""}
        </div>
      </div>

      {/* External link on hover */}
      {hover && (
        <a
          href={asset.sourceUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-2 left-2 flex items-center justify-center w-5 h-5 rounded"
          style={{ background: "rgba(0,0,0,0.5)" }}
        >
          <ExternalLink size={10} color="white" />
        </a>
      )}
    </div>
  );
}
