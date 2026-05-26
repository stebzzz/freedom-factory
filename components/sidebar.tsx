"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Workflow, DollarSign, Settings, ChevronLeft, ChevronRight, Palette, LayoutGrid, Search, Brush, ListChecks, Link2 } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { useEffect, useState } from "react";

const navItems = [
  { href: "/projects", label: "Projects", icon: LayoutGrid },
  { href: "/pipeline", label: "Pipeline", icon: Workflow },
  { href: "/queue", label: "Queue", icon: ListChecks },
  { href: "/channelflow-jobs", label: "Jobs ChannelFlow", icon: Link2 },
  { href: "/sourcing", label: "Sourcing", icon: Search },
  { href: "/style-kit", label: "Style Kit", icon: Brush },
  { href: "/presets", label: "Presets", icon: Palette },
  { href: "/budget", label: "Budget & ROI", icon: DollarSign },
  { href: "/settings", label: "Parametres", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [queueBadge, setQueueBadge] = useState<{ running: number; waiting: number }>({ running: 0, waiting: 0 });

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const [qRes, pRes] = await Promise.all([
          fetch("/api/queue", { cache: "no-store" }),
          fetch("/api/pipeline", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        const qData = qRes.ok ? await qRes.json() : { entries: [] };
        const pData = pRes.ok ? await pRes.json() : [];
        const entries = Array.isArray(qData?.entries) ? qData.entries : [];
        const linkedJobIds = new Set(entries.map((e: { jobId?: string }) => e.jobId).filter(Boolean));
        const directJobs = Array.isArray(pData) ? pData.filter((j: { id: string }) => !linkedJobIds.has(j.id)) : [];

        const running =
          entries.filter((e: { status: string }) => e.status === "running").length
          + directJobs.filter((j: { status: string }) => j.status === "running").length;
        const waiting =
          entries.filter((e: { status: string }) => e.status === "waiting").length
          + directJobs.filter((j: { status: string }) => j.status === "queued").length;
        setQueueBadge({ running, waiting });
      } catch { /* offline, ignore */ }
    };
    pull();
    const t = setInterval(pull, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <aside
      className="sidebar fixed left-0 top-0 h-screen flex flex-col z-50"
      style={{ width: collapsed ? 64 : "var(--sidebar-width)" }}
    >
      {/* Logo */}
      <div className="px-4 pt-6 pb-4 flex items-center gap-2.5">
        <div
          className="flex items-center justify-center rounded-lg flex-shrink-0"
          style={{
            width: 32,
            height: 32,
            background: "var(--accent)",
            borderRadius: 10,
          }}
        >
          <span className="text-white font-black text-[14px]">FF</span>
        </div>
        {!collapsed && (
          <span className="font-bold text-[14px] tracking-tight" style={{ color: "var(--text-primary)" }}>
            Freedom Factory
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 pt-2 flex flex-col gap-0.5">
        <span className="mono-sm px-3 pb-2 pt-1">{!collapsed && "Workspace"}</span>
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          const showBadge = item.href === "/queue" && (queueBadge.running + queueBadge.waiting) > 0;
          const isRunning = item.href === "/queue" && queueBadge.running > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-item ${isActive ? "active" : ""}`}
              style={{ position: "relative" }}
              title={collapsed ? `${item.label}${showBadge ? ` (${queueBadge.running}r / ${queueBadge.waiting}w)` : ""}` : undefined}
            >
              <item.icon size={18} className="flex-shrink-0" />
              {!collapsed && <span className="sidebar-label">{item.label}</span>}
              {!collapsed && showBadge && (
                <span
                  className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                  style={{
                    background: isRunning ? "var(--accent)" : "var(--bg-glass-strong, #2a2a2a)",
                    color: isRunning ? "white" : "var(--text-secondary)",
                    minWidth: 18,
                    textAlign: "center",
                  }}
                  title={`${queueBadge.running} en cours, ${queueBadge.waiting} en attente`}
                >
                  {queueBadge.running + queueBadge.waiting}
                </span>
              )}
              {collapsed && showBadge && (
                <span
                  className="rounded-full"
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 7,
                    height: 7,
                    background: isRunning ? "var(--accent)" : "var(--text-tertiary)",
                  }}
                />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 flex flex-col gap-2">
        <div className="h-px" style={{ background: "var(--border-glass)" }} />
        <div className={`flex items-center pt-1 ${collapsed ? "justify-center" : "justify-between px-1"}`}>
          {!collapsed && <span className="mono-sm">Theme</span>}
          <ThemeToggle />
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="btn-glass w-full justify-center"
          style={{ padding: "5px" }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>
    </aside>
  );
}
