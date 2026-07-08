"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import type { PlayerRef } from "@remotion/player";
import { ShowcaseComposition } from "@/remotion/ShowcaseComposition";
import type { ShowcaseScene } from "@/remotion/ShowcaseComposition";

const ShowcaseCompositionUntyped = ShowcaseComposition as unknown as ComponentType<Record<string, unknown>>;

const Player = dynamic(() => import("@remotion/player").then((m) => m.Player), {
  ssr: false,
});

const FPS = 30;
const FRAMES_DIR = "/showcase/never-kiss/frames";
const AUDIO_URL = "/showcase/never-kiss/vo.mp3";
const SCENES_URL = "/showcase/never-kiss/scenes.json";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function tickEvery(pxPerSec: number): number {
  if (pxPerSec >= 100) return 5;
  if (pxPerSec >= 50) return 10;
  if (pxPerSec >= 25) return 20;
  return 30;
}

const MIN_PX_PER_SEC = 20;
const MAX_PX_PER_SEC = 500;
const DEFAULT_PX_PER_SEC = 140;
const RULER_H = 28;
const VIDEO_TRACK_H = 220;
const AUDIO_TRACK_H = 56;
const SUB_TRACK_H = 56;

export default function NeverKissShowcasePage() {
  const [scenes, setScenes] = useState<ShowcaseScene[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  const playerRef = useRef<PlayerRef | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(SCENES_URL)
      .then((r) => r.json())
      .then(setScenes);
  }, []);

  const durationInFrames = useMemo(() => {
    if (!scenes || scenes.length === 0) return 1;
    return Math.max(1, Math.round(scenes[scenes.length - 1].sceneEnd * FPS));
  }, [scenes]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !scenes) return;
    const onFrame = () => {
      const frame = player.getCurrentFrame();
      const seconds = frame / FPS;
      setCurrentSeconds(seconds);
      let idx = 0;
      for (let i = 0; i < scenes.length; i++) {
        if (seconds >= scenes[i].imageTime) idx = i;
        else break;
      }
      setActiveIndex(idx);
    };
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [scenes]);

  useEffect(() => {
    if (!followPlayhead) return;
    const container = scrollRef.current;
    if (!container) return;
    const playheadX = currentSeconds * pxPerSec;
    const { scrollLeft, clientWidth } = container;
    if (playheadX < scrollLeft + 80 || playheadX > scrollLeft + clientWidth - 120) {
      container.scrollTo({ left: Math.max(0, playheadX - clientWidth / 3), behavior: "smooth" });
    }
  }, [currentSeconds, pxPerSec, followPlayhead]);

  const seekTo = (seconds: number) => {
    playerRef.current?.seekTo(Math.round(seconds * FPS));
    playerRef.current?.play();
  };

  const seekToClientX = (clientX: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left + container.scrollLeft;
    const seconds = Math.max(0, x / pxPerSec);
    seekTo(seconds);
  };

  if (!scenes) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-400 flex items-center justify-center">
        Chargement…
      </main>
    );
  }

  const totalSeconds = scenes[scenes.length - 1].sceneEnd;

  return (
    <main className="h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden">
      <div className="w-full px-4 pt-4 pb-2 flex flex-col flex-1 min-h-0">
        <header className="mb-3 flex items-start justify-between gap-6 shrink-0">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-neutral-500 mb-1">
              Chaîne Volt — Production originale
            </p>
            <h1 className="text-xl md:text-2xl font-semibold text-white">
              Why Did Ancient Humans Never Kiss?
            </h1>
            <p className="mt-1 text-xs text-neutral-500 max-w-2xl">
              {scenes.length} scènes générées individuellement (image + prompt), voix off
              synthétisée et synchronisée mot à mot, sous-titres alignés sur l&apos;audio.
            </p>
          </div>

          <div className="w-72 shrink-0 rounded-lg overflow-hidden border border-neutral-800 bg-black shadow-2xl">
            <Player
              ref={playerRef}
              component={ShowcaseCompositionUntyped}
              inputProps={{
                scenes,
                framesDir: FRAMES_DIR,
                audioUrl: AUDIO_URL,
                fps: FPS,
              }}
              durationInFrames={durationInFrames}
              fps={FPS}
              compositionWidth={1920}
              compositionHeight={1080}
              style={{ width: "100%", aspectRatio: "16 / 9" }}
              controls
              loop
              clickToPlay
            />
          </div>
        </header>

        <section className="mt-2 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <h2 className="text-sm font-medium text-neutral-300">Timeline de production</h2>
            <div className="flex items-center gap-4">
              <span className="text-xs text-neutral-500 tabular-nums">
                {scenes.length} scènes · {formatTime(totalSeconds)} · {formatTime(currentSeconds)} en cours
              </span>
              <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                <input
                  type="checkbox"
                  checked={followPlayhead}
                  onChange={(e) => setFollowPlayhead(e.target.checked)}
                  className="accent-emerald-500"
                />
                suivre la lecture
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-500">Zoom</span>
                <input
                  type="range"
                  min={MIN_PX_PER_SEC}
                  max={MAX_PX_PER_SEC}
                  value={pxPerSec}
                  onChange={(e) => setPxPerSec(Number(e.target.value))}
                  className="w-32 accent-emerald-500"
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden flex-1 min-h-0">
            <div
              ref={scrollRef}
              className="overflow-x-auto overflow-y-auto h-full"
              style={{ scrollbarWidth: "thin" }}
            >
              <div
                className="relative select-none"
                style={{ width: totalSeconds * pxPerSec + 80 }}
              >
                {/* Ruler */}
                <div
                  className="sticky top-0 z-20 bg-neutral-900 border-b border-neutral-800 cursor-pointer"
                  style={{ height: RULER_H }}
                  onClick={(e) => seekToClientX(e.clientX)}
                >
                  {Array.from({ length: Math.ceil(totalSeconds / tickEvery(pxPerSec)) + 1 }).map((_, i) => {
                    const t = i * tickEvery(pxPerSec);
                    return (
                      <div
                        key={i}
                        className="absolute top-0 h-full flex flex-col items-start"
                        style={{ left: t * pxPerSec }}
                      >
                        <div className="w-px h-2 bg-neutral-700" />
                        <span className="text-[10px] text-neutral-500 tabular-nums ml-1">
                          {formatTime(t)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Video / image track */}
                <div
                  className="relative border-b border-neutral-800 bg-neutral-950"
                  style={{ height: VIDEO_TRACK_H }}
                  onClick={(e) => seekToClientX(e.clientX)}
                >
                  <span className="absolute -left-0 top-1 z-10 text-[9px] uppercase tracking-wide text-neutral-600 px-1">
                    V1
                  </span>
                  {scenes.map((scene, i) => {
                    const left = scene.imageTime * pxPerSec;
                    const width = Math.max(2, (scene.sceneEnd - scene.imageTime) * pxPerSec);
                    return (
                      <button
                        key={scene.index}
                        onClick={(e) => {
                          e.stopPropagation();
                          seekTo(scene.imageTime);
                        }}
                        title={scene.text}
                        className={`absolute top-0 h-full overflow-hidden border-r border-neutral-950 ${
                          i === activeIndex ? "ring-2 ring-inset ring-emerald-400" : ""
                        }`}
                        style={{ left, width }}
                      >
                        <img
                          src={`${FRAMES_DIR}/${scene.imageFile}`}
                          alt=""
                          className="w-full h-full object-cover opacity-90"
                          loading="lazy"
                        />
                        {width > 60 && (
                          <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[9px] text-neutral-300 px-1 truncate">
                            #{scene.index + 1}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Audio waveform track */}
                <div
                  className="relative border-b border-neutral-800 bg-neutral-950 cursor-pointer"
                  style={{ height: AUDIO_TRACK_H }}
                  onClick={(e) => seekToClientX(e.clientX)}
                >
                  <span className="absolute left-0 top-1 z-10 text-[9px] uppercase tracking-wide text-neutral-600 px-1">
                    A1 · VO
                  </span>
                  <img
                    src="/showcase/never-kiss/waveform.png"
                    alt="waveform"
                    className="absolute inset-0 w-full h-full object-fill opacity-80"
                    style={{ filter: "drop-shadow(0 0 1px rgba(52,211,153,0.4))" }}
                  />
                  {scenes.map((scene) => (
                    <div
                      key={scene.index}
                      className="absolute top-0 h-full border-r border-neutral-900/60"
                      style={{ left: scene.imageTime * pxPerSec }}
                    />
                  ))}
                </div>

                {/* Subtitle track */}
                <div
                  className="relative bg-neutral-950"
                  style={{ height: SUB_TRACK_H }}
                  onClick={(e) => seekToClientX(e.clientX)}
                >
                  <span className="absolute left-0 top-1 z-10 text-[9px] uppercase tracking-wide text-neutral-600 px-1">
                    SUB
                  </span>
                  {scenes.map((scene, i) => {
                    const left = scene.imageTime * pxPerSec;
                    const width = Math.max(2, (scene.sceneEnd - scene.imageTime) * pxPerSec);
                    return (
                      <button
                        key={scene.index}
                        onClick={(e) => {
                          e.stopPropagation();
                          seekTo(scene.imageTime);
                        }}
                        title={scene.text}
                        className={`absolute top-0 h-full text-left px-1.5 py-1 border-r border-neutral-900 rounded-[2px] overflow-hidden ${
                          i === activeIndex ? "bg-emerald-500/20 ring-1 ring-emerald-500/60" : "bg-neutral-900 hover:bg-neutral-800"
                        }`}
                        style={{ left, width }}
                      >
                        <span className="block text-[10px] leading-tight text-neutral-300 truncate">
                          {scene.text}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Playhead */}
                <div
                  className="absolute top-0 bottom-0 w-px bg-red-500 z-30 pointer-events-none"
                  style={{ left: currentSeconds * pxPerSec }}
                >
                  <div className="w-2 h-2 bg-red-500 rounded-full -translate-x-1/2 -mt-1" />
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
