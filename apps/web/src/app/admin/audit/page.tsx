"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { PageHeader, Skeleton, useToast } from "@/components/ui";

interface Entry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actor: string;
  after: any;
  createdAt: string;
}

const LABEL: Record<string, string> = {
  "platform.login": "Inicio de sesión",
  "platform.mfa.enabled": "MFA activado",
  "platform.mfa.disabled": "MFA desactivado",
  "platform.impersonate": "Impersonación de tenant",
  "platform.org.suspended": "Tenant suspendido",
  "platform.org.active": "Tenant reactivado",
  "platform.org.trial": "Tenant a prueba",
  "platform.org.cancelled": "Tenant cancelado",
  "platform.plan.create": "Plan creado",
  "platform.plan.update": "Plan actualizado",
};

export default function AuditPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Entry[] | null>(null);

  const load = useCallback(async () => {
    setRows(await padmin<Entry[]>("/platform/audit"));
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <PageHeader title="Auditoría" description="Acciones realizadas desde la administración de la plataforma (últimas 100)." />
      {!rows ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Acción</th>
                <th className="p-3">Actor</th>
                <th className="p-3">Entidad</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-slate-400">Sin registros aún.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="p-3 font-medium text-navy-900">{LABEL[r.action] ?? r.action}</td>
                    <td className="p-3 text-slate-600">{r.actor}</td>
                    <td className="p-3 text-slate-500">
                      {r.entityType ?? "—"}
                      {r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}
                    </td>
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
