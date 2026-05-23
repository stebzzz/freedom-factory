"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ProjectState } from "@/lib/projects/types";

interface ApiResponse extends ProjectState {
  activeConcat: { id: string; status: string; clipsCount: number; outUrl?: string } | null;
}

export function useProjectState(slug: string) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cancelled = useRef(false);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${slug}`, { cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const next: ApiResponse = await res.json();
      if (!cancelled.current) {
        setData(next);
        setError(null);
      }
    } catch (e) {
      if (!cancelled.current) setError((e as Error).message);
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [slug]);

  const isBusy = !!data?.activeRun || data?.activeConcat?.status === "running";
  useEffect(() => {
    cancelled.current = false;
    fetchOnce();
    const id = setInterval(fetchOnce, isBusy ? 2500 : 8000);
    return () => {
      cancelled.current = true;
      clearInterval(id);
    };
  }, [slug, isBusy, fetchOnce]);

  return { data, error, loading, refetch: fetchOnce };
}

export function useProjects() {
  const [data, setData] = useState<{ projects: unknown[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOnce();
    const id = setInterval(fetchOnce, 6000);
    return () => clearInterval(id);
  }, [fetchOnce]);

  return { data, error, loading, refetch: fetchOnce };
}
