"use client";

import { useEffect, useState } from "react";
import { TrendingDown } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { PageHeader, Skeleton } from "@/components/ui";

interface Row {
  id: string;
  name: string;
  revenueClp: number;
  metaCostClp: number;
  aiCostClp: number;
  marginClp: number;
  marginPct: number | null;
}

const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;

export default function MarginsPage() {
  const [data, setData] = useState<{ month: string; rows: Row[] } | null>(null);

  useEffect(() => {
    void padmin<{ month: string; rows: Row[] }>("/platform/margins").then(setData).catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6 lg:px-8">
      <PageHeader
        title="Margen por cliente"
        description="Ingreso cobrado del mes menos el costo real de Meta (mensajería) y de IA, por tenant. Los que pierden plata aparecen primero."
      />

      {!data ? (
        <Skeleton className="h-64" />
      ) : data.rows.length === 0 ? (
        <p className="rounded-card border border-slate-200 bg-white p-8 text-center text-slate-500">Sin datos este mes.</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] uppercase text-slate-400">
                <th className="px-3 py-2">Tenant</th>
                <th className="px-3 py-2 text-right">Ingreso</th>
                <th className="px-3 py-2 text-right">Costo Meta</th>
                <th className="px-3 py-2 text-right">Costo IA</th>
                <th className="px-3 py-2 text-right">Margen</th>
                <th className="px-3 py-2 text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const neg = r.marginClp < 0;
                return (
                  <tr key={r.id} className={`border-b border-slate-100 ${neg ? "bg-red-50" : ""}`}>
                    <td className="px-3 py-2 font-medium text-navy-900">
                      {neg && <TrendingDown size={13} className="mr-1 inline text-red-500" />}
                      {r.name}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-700">{clp(r.revenueClp)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{clp(r.metaCostClp)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{clp(r.aiCostClp)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${neg ? "text-red-600" : "text-emerald-700"}`}>{clp(r.marginClp)}</td>
                    <td className={`px-3 py-2 text-right ${neg ? "text-red-600" : "text-slate-500"}`}>{r.marginPct === null ? "—" : `${r.marginPct}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">
        Mes {data?.month ?? ""}. Costos convertidos a CLP con el tipo de cambio del Super Admin. Un margen negativo = ese cliente te cuesta más de lo que te paga.
      </p>
    </div>
  );
}
