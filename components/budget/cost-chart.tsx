"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LineChart, Line } from "recharts";
import { budgetChartData, projectionData } from "@/lib/data";

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload) return null;
  return (
    <div className="glass-strong" style={{ padding: "10px 14px", borderRadius: 12, fontSize: 12 }}>
      <p className="font-semibold mb-1" style={{ color: "var(--text-primary)" }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>{p.name}: ${p.value}</p>
      ))}
    </div>
  );
}

export function CostBarChart() {
  return (
    <div className="glass-static p-6" style={{ borderRadius: "var(--radius-lg)" }}>
      <div className="flex items-center justify-between mb-5">
        <h3 className="heading-md">Repartition mensuelle</h3>
        <span className="mono-sm">par poste</span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={budgetChartData} barGap={2} barCategoryGap="25%">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-glass)" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} width={40} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11, color: "var(--text-tertiary)", paddingTop: 8 }} />
          <Bar dataKey="optimal" name="Optimal" fill="var(--accent)" radius={[5, 5, 0, 0]} />
          <Bar dataKey="budget" name="Budget" fill="var(--green)" radius={[5, 5, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ProjectionChart() {
  return (
    <div className="glass-static p-6" style={{ borderRadius: "var(--radius-lg)" }}>
      <div className="flex items-center justify-between mb-5">
        <h3 className="heading-md">Projection 3 mois</h3>
        <span className="mono-sm">tendance</span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={projectionData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-glass)" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} width={40} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
          <Line type="monotone" dataKey="optimal" name="Optimal" stroke="var(--accent)" strokeWidth={2} dot={{ r: 4, fill: "var(--accent)", strokeWidth: 0 }} />
          <Line type="monotone" dataKey="budget" name="Budget" stroke="var(--green)" strokeWidth={2} dot={{ r: 4, fill: "var(--green)", strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
