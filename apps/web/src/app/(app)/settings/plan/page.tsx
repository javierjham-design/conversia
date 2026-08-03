"use client";

/** Plan y uso (solo lectura): plan actual, consumo del período y accesos a facturación. */
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui";

interface BillingOverview {
  plan: { code: string; name: string; priceClp: number; priceUsd: number; interval: string } | null;
  usage: Record<string, { used: number; limit: number | null }>;
}

const USAGE_LABELS: Record<string, string> = {
  aiTokensDaily: "Tokens IA (hoy)",
  messagesMonthly: "Mensajes (mes)",
  contacts: "Contactos",
  agents: "Agentes IA",
  workflows: "Flujos",
  users: "Usuarios",
};

export default function PlanSettingsPage() {
  const [data, setData] = useState<BillingOverview | null>(null);

  useEffect(() => {
    void api<BillingOverview>("/billing/me").then(setData).catch(() => setData({ plan: null, usage: {} }));
  }, []);

  if (!data) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Plan y uso</h2>
      <p className="mt-1 text-xs text-slate-500">
        Consumo del espacio según lo que registra la plataforma. Para cambiar de plan o ver pagos ve a{" "}
        <a href="/billing" className="inline-flex items-center gap-0.5 text-cyan-700 underline">Plan y facturación <ExternalLink size={10} /></a>.
      </p>

      <div className="mt-4 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <p className="text-sm font-medium">Plan actual</p>
        {data.plan ? (
          <p className="mt-1 text-lg font-semibold text-cyan-800">{data.plan.name}</p>
        ) : (
          <p className="mt-1 text-sm text-slate-400">Sin plan asignado (contacta a TuBot).</p>
        )}
      </div>

      <div className="mt-4 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <p className="text-sm font-medium">Consumo</p>
        <ul className="mt-2 space-y-2">
          {Object.entries(data.usage).length === 0 && <p className="text-xs text-slate-400">Sin métricas disponibles.</p>}
          {Object.entries(data.usage).map(([key, u]) => {
            const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : null;
            return (
              <li key={key} className="text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-600">{USAGE_LABELS[key] ?? key}</span>
                  <span className="text-slate-400">
                    {u.used.toLocaleString("es-CL")}{u.limit ? ` / ${u.limit.toLocaleString("es-CL")}` : ""}
                  </span>
                </div>
                {pct !== null && (
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full ${pct > 90 ? "bg-red-400" : pct > 70 ? "bg-amber-400" : "bg-cyan-500"}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
