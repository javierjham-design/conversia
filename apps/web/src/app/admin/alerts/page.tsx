"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { PageHeader, Skeleton, useToast } from "@/components/ui";

interface Alert {
  id: string;
  provider: string;
  type: string;
  status: string;
  message: string | null;
  org: string;
  createdAt: string;
}

export default function AlertsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Alert[] | null>(null);

  const load = useCallback(async () => {
    setRows(await padmin<Alert[]>("/platform/alerts"));
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <PageHeader title="Alertas" description="Avisos y errores de integración de todos los tenants (salud de Meta, IA en pausa, suspensiones…)." />
      {!rows ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Nivel</th>
                <th className="p-3">Tenant</th>
                <th className="p-3">Evento</th>
                <th className="p-3">Detalle</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-400">Sin alertas. Todo en orden ✔</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          r.status === "error" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {r.status === "error" ? "error" : "aviso"}
                      </span>
                    </td>
                    <td className="p-3 font-medium text-navy-900">{r.org}</td>
                    <td className="p-3 text-slate-500">
                      <span className="text-slate-400">{r.provider}</span> · {r.type}
                    </td>
                    <td className="p-3 text-slate-600">{r.message ?? "—"}</td>
                    <td className="p-3 text-slate-400">{new Date(r.createdAt).toLocaleString("es-CL")}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
