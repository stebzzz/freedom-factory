"use client";

import { ScenarioCard } from "@/components/budget/scenario-card";
import { CostBarChart, ProjectionChart } from "@/components/budget/cost-chart";
import { PricingTable } from "@/components/budget/pricing-table";
import { scenarioA, scenarioB } from "@/lib/data";

export default function BudgetPage() {
  return (
    <div className="flex flex-col gap-12">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <span className="mono-sm">Workspace / Finances</span>
        <h1 className="heading-xl mt-2">Budget & ROI</h1>
        <p className="text-[15px] max-w-lg mt-1" style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Estimation pour 10 videos longues par mois.
          Qualite pro, cout derisoire.
        </p>
      </div>

      {/* Big numbers - editorial, asymmetric */}
      <div className="flex items-end gap-12 flex-wrap">
        <div>
          <span className="mono-sm">Cout mensuel</span>
          <div className="stat-value text-[48px] mt-1">$108<span className="text-[24px] font-normal" style={{ color: "var(--text-tertiary)" }}>-118</span></div>
        </div>
        <div>
          <span className="mono-sm">Par video</span>
          <div className="stat-value text-[48px] mt-1" style={{ color: "var(--green)" }}>~$11</div>
        </div>
        <div className="pb-1">
          <span className="mono-sm">vs production trad.</span>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[28px] font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>85-95%</span>
            <span className="text-[13px]" style={{ color: "var(--text-tertiary)" }}>moins cher</span>
          </div>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>$50-200/video en traditionnel</p>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px" style={{ background: "var(--border-glass)" }} />

      {/* Scenarios */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <h2 className="heading-lg">Scenarios</h2>
          <span className="mono-sm">10 videos/mois &middot; ~150-200 img/video</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ScenarioCard scenario={scenarioA} recommended />
          <ScenarioCard scenario={scenarioB} />
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CostBarChart />
        <ProjectionChart />
      </div>

      {/* Pricing table */}
      <PricingTable />
    </div>
  );
}
