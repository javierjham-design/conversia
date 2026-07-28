"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [detail, setDetail] = useState<any | null>(null);

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

  async function openDetail(id: string) {
    setDetail(await padmin(`/platform/organizations/${id}`));
  }

  async function impersonate(id: string) {
    if (!window.confirm("Entrarás como el usuario de este tenant para dar soporte. La sesión dura 30 min y queda registrada en auditoría. ¿Continuar?")) return;
    try {
      const res = await padmin<{ token: string; user: { email: string } }>(`/platform/organizations/${id}/impersonate`, { method: "POST" });
      window.localStorage.setItem("conversia_token", res.token);
      toast.push(`Entrando como ${res.user.email}…`, "ok");
      window.open("/", "_blank");
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Organizaciones" description="Todos los tenants de la plataforma. Suspende, activa y asigna planes." />
      {!orgs ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Organización</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Plan</th>
                <th className="p-3">Uso</th>
                <th className="p-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="p-3">
                    <button onClick={() => void openDetail(o.id)} className="text-left font-medium hover:text-brand-700">{o.name}</button>
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
                  <td className="p-3 text-xs text-slate-500">{o.counts.users}u · {o.counts.agents}a · {o.counts.conversations}c</td>
                  <td className="p-3">
                    {o.status === "SUSPENDED" ? (
                      <Button variant="secondary" onClick={() => void setStatus(o.id, "ACTIVE")}>Reactivar</Button>
                    ) : (
                      <Button variant="danger" onClick={() => void setStatus(o.id, "SUSPENDED")}>Suspender</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog">
          <div className="absolute inset-0 bg-navy-950/50" onClick={() => setDetail(null)} />
          <div className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-pop">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{detail.organization.name}</h2>
              <button onClick={() => setDetail(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <p className="text-sm text-slate-500">{detail.organization.slug} · {detail.organization.status} · {detail.subscription?.planName ?? "sin plan"} ({detail.subscription?.status ?? "—"})</p>
            <div className="mt-3">
              <Button variant="secondary" onClick={() => void impersonate(detail.organization.id)}>
                Entrar como este tenant (soporte)
              </Button>
            </div>

            <h3 className="mt-4 mb-1 text-sm font-semibold">Consumo (últimos 30 días)</h3>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Clientes activos", value: detail.metrics?.activeClients ?? 0 },
                { label: "Conversaciones", value: detail.metrics?.conversationsInitiated ?? 0 },
                {
                  label: "Costo IA (USD)",
                  value: `$${Number(detail.usage?.find((u: any) => u.type === "ai_tokens")?._sum?.costUsd ?? 0).toFixed(2)}`,
                },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-lg font-semibold text-navy-900">{s.value}</div>
                  <div className="text-[11px] text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>
            {detail.usage?.length > 0 && (
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {detail.usage.map((u: any) => (
                    <tr key={u.type} className="border-t border-slate-100">
                      <td className="py-1 text-slate-500">{u.type}</td>
                      <td className="py-1 text-right">{Number(u._sum?.quantity ?? 0).toLocaleString("es-CL")}</td>
                      <td className="py-1 text-right text-slate-400">US${Number(u._sum?.costUsd ?? 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3 className="mt-4 mb-1 text-sm font-semibold">Miembros ({detail.members.length})</h3>
            <ul className="text-xs text-slate-600">
              {detail.members.map((m: any) => (<li key={m.email}>{m.name} · {m.email} {m.active ? "" : "(inactivo)"}</li>))}
            </ul>
            <h3 className="mt-4 mb-1 text-sm font-semibold">Facturas</h3>
            {detail.invoices.length === 0 ? (
              <p className="text-xs text-slate-400">Sin facturas.</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {detail.invoices.map((inv: any) => (
                    <tr key={inv.id} className="border-t border-slate-100">
                      <td className="py-1 font-mono">{inv.number}</td>
                      <td className="py-1">{inv.currency} {Number(inv.amountDue).toLocaleString("es-CL")}</td>
                      <td className="py-1">{inv.status}</td>
                      <td className="py-1 text-slate-400">{new Date(inv.createdAt).toLocaleDateString("es-CL")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
