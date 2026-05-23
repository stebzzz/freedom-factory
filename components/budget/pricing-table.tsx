import { pricingFalai } from "@/lib/data";

export function PricingTable() {
  return (
    <div className="glass-static overflow-hidden" style={{ borderRadius: "var(--radius-lg)" }}>
      <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border-glass)" }}>
        <h3 className="heading-md">Modèles vidéo via GenAIPro</h3>
        <span className="badge badge-green">GenAIPro</span>
      </div>
      <div className="overflow-x-auto">
        <table className="glass-table">
          <thead>
            <tr>
              <th>Modèle</th>
              <th>Provider</th>
              <th>Officiel</th>
              <th className="text-right">Note</th>
            </tr>
          </thead>
          <tbody>
            {pricingFalai.map((row) => (
              <tr key={row.modele}>
                <td><span className="font-medium">{row.modele}</span></td>
                <td><span className="font-mono font-semibold" style={{ color: "var(--green)" }}>{row.prixFalai}</span></td>
                <td><span className="font-mono" style={{ color: "var(--text-tertiary)" }}>{row.prixOfficiel}</span></td>
                <td className="text-right">
                  <span className={`badge ${row.economie !== "--" ? "badge-green" : "badge-gray"}`}>{row.economie}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
