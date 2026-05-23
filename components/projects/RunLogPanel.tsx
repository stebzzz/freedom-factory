"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Terminal } from "lucide-react";

interface Props {
  slug: string;
  runId?: string;
  active: boolean;
}

export function RunLogPanel({ slug, runId, active }: Props) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active && !runId) {
      setLog([]);
      return;
    }
    if (!open && !active) return;
    let cancelled = false;
    const fetchLog = async () => {
      try {
        const url = `/api/projects/${slug}/log${runId ? `?runId=${runId}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data: { log?: string[] } = await res.json();
        if (!cancelled) setLog(data.log ?? []);
      } catch {}
    };
    fetchLog();
    const interval = setInterval(fetchLog, active ? 1500 : 6000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [slug, runId, active, open]);

  useEffect(() => {
    if (open && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [log, open]);

  if (!active && log.length === 0 && !open) return null;

  const lastLine = log[log.length - 1] ?? "(no output yet)";

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-30"
      style={{
        marginLeft: "var(--sidebar-width)",
        background: "var(--bg-glass-active)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid var(--border-glass-strong)",
        boxShadow: "0 -8px 24px rgba(0,0,0,0.15)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-6 py-2.5 text-left"
      >
        <Terminal size={14} style={{ color: "var(--text-secondary)" }} />
        <span className="mono-sm">Live log</span>
        {active && <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--green)" }} />}
        <span className="text-[12px] flex-1 truncate font-mono" style={{ color: "var(--text-secondary)" }}>
          {lastLine}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {open && (
        <div
          ref={tailRef}
          className="font-mono text-[11px] leading-relaxed px-6 py-3 overflow-y-auto"
          style={{
            maxHeight: 320,
            color: "var(--text-secondary)",
            background: "var(--bg-secondary)",
            borderTop: "1px solid var(--border-glass)",
          }}
        >
          {log.length === 0 ? (
            <div style={{ color: "var(--text-tertiary)" }}>(no log)</div>
          ) : (
            log.map((line, i) => {
              const isErr = line.startsWith("[err]");
              const isOK = /^OK /.test(line);
              const isFail = /^FAIL |^STUCK /.test(line);
              return (
                <div
                  key={i}
                  style={{
                    color: isErr || isFail ? "var(--red)" : isOK ? "var(--green)" : "inherit",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {line}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
