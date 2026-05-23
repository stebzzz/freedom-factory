"use client";

import { useEffect, useState, useCallback } from "react";

const KEY = "ff_preview_audio";
const EVENT = "ff:preview-audio-changed";

function read(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(KEY) === "1";
}

/**
 * Global toggle for whether hover previews in SceneCard play with audio.
 * Default OFF (muted) — clips have Veo3-generated audio so unmuting on every
 * card hover would be noisy by default. Persists in localStorage, syncs across
 * tabs via the storage event, and across components in the same tab via a
 * custom event.
 */
export function usePreviewAudio(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(false);

  useEffect(() => {
    setEnabled(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setEnabled(read());
    };
    const onCustom = () => setEnabled(read());
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT, onCustom);
    };
  }, []);

  const set = useCallback((next: boolean) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY, next ? "1" : "0");
    window.dispatchEvent(new Event(EVENT));
    setEnabled(next);
  }, []);

  return [enabled, set];
}
