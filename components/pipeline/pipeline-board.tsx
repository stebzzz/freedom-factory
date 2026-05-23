"use client";

import { pipelineSteps } from "@/lib/data";
import { StepCard } from "./step-card";

export function PipelineBoard() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {pipelineSteps.map((step) => (
        <StepCard key={step.id} step={step} />
      ))}
    </div>
  );
}
