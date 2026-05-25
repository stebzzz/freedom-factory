"use client";

import { useState, useRef, useEffect } from "react";
import type { Scene } from "@/lib/projects/types";
import { statusDot } from "./StatusBadge";
import { usePreviewAudio } from "./usePreviewAudio";

interface Props {
  scene: Scene;
  onClick: () => void;
  selectable?: boolean;
  selected?: boolean;
}

export function SceneCard({ scene, onClick, selectable = false, selected = false }: Props) {
  const [hover, setHover] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audioEnabled] = usePreviewAudio();

  // Keep the live element's muted attribute in sync with the global toggle so
  // currently-hovered previews respond immediately when the user flips it.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audioEnabled;
  }, [audioEnabled]);

  const onEnter = () => {
    setHover(true);
    if (scene.clipUrl && videoRef.current) {
      videoRef.current.muted = !audioEnabled;
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
    <button
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      className="group glass-static text-left overflow-hidden relative aspect-video w-full transition-all duration-200 hover:scale-[1.015]"
      style={{
        borderRadius: "var(--radius-sm)",
        outline: selected ? "3px solid var(--accent)" : undefined,
        outlineOffset: selected ? "-3px" : undefined,
      }}
    >
      {scene.clipUrl ? (
        <video
          ref={videoRef}
          src={scene.clipUrl}
          muted={!audioEnabled}
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : scene.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={scene.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: "var(--bg-glass-hover)" }}>
          <span className="mono-sm">no clip</span>
        </div>
      )}

      {/* Gradient overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 50%)" }}
      />

      {/* Selection checkbox (visible in select mode) */}
      {selectable && (
        <div
          className="absolute top-2.5 left-2.5 w-5 h-5 rounded flex items-center justify-center z-10"
          style={{
            background: selected ? "var(--accent)" : "rgba(0,0,0,0.5)",
            border: `2px solid ${selected ? "var(--accent)" : "rgba(255,255,255,0.7)"}`,
            backdropFilter: "blur(4px)",
          }}
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          )}
        </div>
      )}

      {/* Status dot */}
      <div
        className="absolute top-2.5 left-2.5 w-2 h-2 rounded-full ring-2 ring-black/20"
        style={{ background: statusDot(scene.status), boxShadow: `0 0 10px ${statusDot(scene.status)}` }}
      />

      {/* ID + duration */}
      <div className="absolute top-2 right-2.5 mono-sm text-white/85" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.6)" }}>
        #{String(scene.id).padStart(3, "0")}
        {scene.durationSec ? ` · ${scene.durationSec}s` : ""}
      </div>

      {/* Title */}
      <div className="absolute bottom-0 left-0 right-0 px-3 py-2.5 z-10">
        <div className="text-[12px] font-semibold text-white leading-tight line-clamp-2" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
          {scene.title || scene.section || `Scene ${scene.id}`}
        </div>
        {scene.videoAttempt && scene.videoAttempt > 1 && (
          <div className="mono-sm text-white/60 mt-1">attempt {scene.videoAttempt}</div>
        )}
      </div>

      {/* Hover play indicator */}
      {scene.clipUrl && hover && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}
    </button>
  );
}
