"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast, type StatusKind } from "@/components/ui";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  country: string;
  createdAt: string;
  plan: { code: string; name: string } | null;
  subscriptionStatus: string | null;
  counts: { users: number; conversations: number; agents: number };
  messaging?: { blocked: boolean; blockedBy: string | null; reason: string | null };
}
interface Plan {
  code: string;
  name: string;
}

const STATUS_KIND: Record<string, StatusKind> = {
  ACTIVE: "connected",
  TRIAL: "beta",
  SUSPENDED: "attention",
  CANCELLED: "disconnected",
};

export default function OrganizationsPage() {
  const toast = useToast();
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([padmin<OrgRow[]>("/platform/organizations"), padmin<Plan[]>("/platform/plans")]);
    setOrgs(o);
    setPlans(p);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function setStatus(id: string, status: string) {
    await padmin(`/platform/organizations/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
    toast.push(`Estado actualizado a ${status}`, "ok");
    await load();
  }

  async function assignPlan(id: string, planCode: string) {
    if (!planCode) return;
    await padmin(`/platform/organizations/${id}/subscription`, { method: "POST", body: JSON.stringify({ planCode, status: "ACTIVE" }) });
    toast.push(`Plan ${planCode} asignado`, "ok");
    await load();
  }

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Organizaciones" description="Todos los tenants. Abre cada uno para configurarlo por completo (vigencia, límites, uso, costos)." />
      {!orgs ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Organización</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Plan</th>
                <th className="p-3">Envío</th>
                <th className="p-3">Uso</th>
                <th className="p-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="p-3">
                    <Link href={`/admin/organizations/${o.id}`} className="text-left font-medium hover:text-brand-700">{o.name}</Link>
                    <div className="text-xs text-slate-400">{o.slug} · {o.country}</div>
                  </td>
                  <td className="p-3"><StatusBadge kind={STATUS_KIND[o.status] ?? "disconnected"} label={o.status.toLowerCase()} /></td>
                  <td className="p-3">
                    <select
                      value={o.plan?.code ?? ""}
                      onChange={(e) => void assignPlan(o.id, e.target.value)}
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                    >
                      <option value="">— sin plan —</option>
                      {plans.map((p) => (
                        <option key={p.code} value={p.code}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-3">
                    {o.messaging ? (
                      o.messaging.blocked ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-700" title={o.messaging.reason ?? "Bloqueado"}>
                          <span className="inline-block h-2 w-2 rounded-full bg-red-500" /> {o.messaging.reason ?? "Bloqueado"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700" title="Puede enviar plantillas">
                          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> OK
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-slate-500">{o.counts.users}u · {o.counts.agents}a · {o.counts.conversations}c</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Link href={`/admin/organizations/${o.id}`} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
                        Configurar
                      </Link>
                      {o.status === "SUSPENDED" ? (
                        <Button variant="secondary" onClick={() => void setStatus(o.id, "ACTIVE")}>Reactivar</Button>
                      ) : (
                        <Button variant="danger" onClick={() => void setStatus(o.id, "SUSPENDED")}>Suspender</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
