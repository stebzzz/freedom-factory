import { Scenario } from "@/lib/types";

export function ScenarioCard({ scenario, recommended = false }: { scenario: Scenario; recommended?: boolean }) {
  return (
    <div
      className="glass-static flex flex-col overflow-hidden"
      style={{
        borderRadius: "var(--radius-lg)",
        border: recommended ? "1.5px solid var(--accent)" : undefined,
      }}
    >
      {/* Header */}
      <div className="px-6 py-4 flex items-baseline justify-between" style={{ borderBottom: "1px solid var(--border-glass)" }}>
        <div className="flex items-baseline gap-3">
          <h3 className="heading-md">
            {scenario.name === "A" ? "Optimal" : "Budget"}
          </h3>
          {recommended && <span className="badge badge-accent">recommande</span>}
        </div>
        <span className="mono-sm">{scenario.label}</span>
      </div>

      {/* Price */}
      <div className="px-6 py-5 flex items-baseline gap-3" style={{ borderBottom: "1px solid var(--border-glass)" }}>
        <span className="text-[36px] font-black tracking-tighter" style={{ color: "var(--text-primary)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
          ${scenario.totalMin}
        </span>
        <span className="text-[14px]" style={{ color: "var(--text-tertiary)" }}>
          - ${scenario.totalMax}/mois
        </span>
        <span className="badge badge-green ml-auto">{scenario.costPerVideo}/video</span>
      </div>

      {/* Items */}
      <div className="px-6 py-3">
        {scenario.items.map((item, i) => (
          <div
            key={item.poste}
            className="flex items-center justify-between py-2.5"
            style={{ borderBottom: i < scenario.items.length - 1 ? "1px solid var(--border-glass)" : "none" }}
          >
            <div className="flex flex-col">
              <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{item.poste}</span>
              <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>{item.outil}</span>
            </div>
            <span className="text-[13px] font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
              {item.coutMois}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
