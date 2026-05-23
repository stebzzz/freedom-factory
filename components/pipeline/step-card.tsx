"use client";

import { PipelineStep, StepStatus } from "@/lib/types";
import { GlowCard } from "@/components/ui/spotlight-card";
import {
  FileText, Mic, Image, Sparkles, LayoutGrid, Images, Film, Play, CheckCircle2, Loader2, Clock, AlertCircle,
} from "lucide-react";

const iconMap: Record<string, React.ElementType> = {
  FileText, Mic, Image, Sparkles, LayoutGrid, Images, Film,
};

const statusConfig: Record<StepStatus, { label: string; color: string; icon: React.ElementType }> = {
  completed: { label: "Done", color: "var(--green)", icon: CheckCircle2 },
  in_progress: { label: "Running", color: "var(--blue)", icon: Loader2 },
  waiting: { label: "Queued", color: "var(--text-tertiary)", icon: Clock },
  error: { label: "Error", color: "var(--red)", icon: AlertCircle },
};

const glowColors: Record<StepStatus, "green" | "blue" | "purple" | "orange"> = {
  completed: "green",
  in_progress: "blue",
  waiting: "purple",
  error: "red" as "orange",
};

export function StepCard({ step }: { step: PipelineStep }) {
  const Icon = iconMap[step.icon] || FileText;
  const status = statusConfig[step.status];
  const StatusIcon = status.icon;

  return (
    <GlowCard
      glowColor={glowColors[step.status]}
      customSize
      className="!aspect-auto !grid-rows-none !gap-0 !p-0 !shadow-none flex flex-col"
    >
      <div className="relative z-10 flex flex-col gap-3 p-5">
        {/* Step number + icon */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Icon size={18} style={{ color: status.color }} />
            <span className="mono-sm">Etape {step.id}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIcon
              size={13}
              style={{ color: status.color }}
              className={step.status === "in_progress" ? "animate-spin" : ""}
            />
            <span className="text-[11px] font-semibold" style={{ color: status.color }}>
              {status.label}
            </span>
          </div>
        </div>

        {/* Title */}
        <div>
          <h3 className="heading-md">{step.name}</h3>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
            {step.tool}
          </p>
        </div>

        {/* Description */}
        <p className="text-[12px] leading-[1.5]" style={{ color: "var(--text-secondary)" }}>
          {step.description}
        </p>

        {/* Progress */}
        {step.status === "in_progress" && (
          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="mono-sm">Progress</span>
              <span className="text-[11px] font-bold" style={{ color: "var(--blue)" }}>
                {step.progress}%
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${step.progress}%`, background: "var(--blue)" }} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1" style={{ borderTop: "1px solid var(--border-glass)" }}>
          <span className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
            {step.costEstimate}
          </span>
          {step.status === "waiting" && (
            <button className="btn-glass" style={{ padding: "4px 10px", fontSize: 11 }}>
              <Play size={10} />
              Run
            </button>
          )}
        </div>
      </div>
    </GlowCard>
  );
}
