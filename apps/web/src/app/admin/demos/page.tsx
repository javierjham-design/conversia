"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, useToast } from "@/components/ui";

interface Lead {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  planInterest: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  organizationId: string | null;
  orgStatus: string | null;
  daysOnPlatform: number | null;
  aiEnabled: boolean | null;
  validUntil: string | null;
}

const STATUSES = ["NEW", "CONTACTED", "PROVISIONED", "ACTIVE", "WON", "LOST"];
const STATUS_LABEL: Record<string, string> = {
  NEW: "Nuevo",
  CONTACTED: "Contactado",
  PROVISIONED: "Demo creado",
  ACTIVE: "Activo",
  WON: "Ganado",
  LOST: "Perdido",
};

export default function DemosPage() {
  const toast = useToast();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [creds, setCreds] = useState<{ email: string; tempPassword: string | null; validUntil?: string } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", company: "", phone: "" });

  const load = useCallback(async () => {
    setLeads(await padmin<Lead[]>("/platform/demo-leads"));
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function provision(l: Lead) {
    if (!window.confirm(`Crear demo para ${l.company ?? l.name}? Se crea la cuenta con la IA PAUSADA (no gasta tokens hasta que la habilites).`)) return;
    try {
      const res = await padmin<{ email: string; tempPassword: string | null; validUntil?: string }>(`/platform/demo-leads/${l.id}/provision`, { method: "POST" });
      setCreds(res);
      toast.push("Demo creado", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }
  async function setStatus(id: string, status: string) {
    await padmin(`/platform/demo-leads/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await load();
  }
  async function createLead(e: React.FormEvent) {
    e.preventDefault();
    try {
      await padmin("/platform/demo-leads", {
        method: "POST",
        body: JSON.stringify({ name: form.name, email: form.email, company: form.company || undefined, phone: form.phone || undefined }),
      });
      setForm({ name: "", email: "", company: "", phone: "" });
      toast.push("Prospecto agregado", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Demos / CRM" description="Prospectos que piden demo. Créalos con la IA pausada y habilítalos cuando estés listo." />

      <form onSubmit={createLead} className="mb-5 flex flex-wrap items-end gap-2 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <label className="text-sm">Nombre<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 block w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
        <label className="text-sm">Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1 block w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
        <label className="text-sm">Empresa<input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="mt-1 block w-44 rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
        <label className="text-sm">Teléfono<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1 block w-36 rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
        <Button type="submit">Agregar prospecto</Button>
      </form>

      {!leads ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Prospecto</th>
                <th className="p-3">Estado</th>
                <th className="p-3">En plataforma</th>
                <th className="p-3">IA</th>
                <th className="p-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 ? (
                <tr><td colSpan={5} className="p-6 text-center text-slate-400">Aún no hay prospectos. Los de la web aparecen aquí.</td></tr>
              ) : (
                leads.map((l) => (
                  <tr key={l.id} className="border-t border-slate-100">
                    <td className="p-3">
                      <div className="font-medium">{l.company ?? l.name}</div>
                      <div className="text-xs text-slate-400">{l.name} · {l.email}{l.phone ? ` · ${l.phone}` : ""}</div>
                    </td>
                    <td className="p-3">
                      <select value={l.status} onChange={(e) => void setStatus(l.id, e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
                        {STATUSES.map((s) => (<option key={s} value={s}>{STATUS_LABEL[s]}</option>))}
                      </select>
                    </td>
                    <td className="p-3 text-xs text-slate-500">
                      {l.daysOnPlatform != null ? `${l.daysOnPlatform} día${l.daysOnPlatform === 1 ? "" : "s"}` : "—"}
                      {l.validUntil && <div className="text-[10px] text-slate-400">vence {new Date(l.validUntil).toLocaleDateString("es-CL")}</div>}
                    </td>
                    <td className="p-3 text-xs">
                      {l.aiEnabled == null ? (
                        <span className="text-slate-400">—</span>
                      ) : l.aiEnabled ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">habilitada</span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">pausada</span>
                      )}
                    </td>
                    <td className="p-3">
                      {l.organizationId ? (
                        <Link href={`/admin/organizations/${l.organizationId}`} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
                          Gestionar / habilitar IA
                        </Link>
                      ) : (
                        <Button onClick={() => void provision(l)}>Crear demo</Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {creds && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog">
          <div className="absolute inset-0 bg-navy-950/50" onClick={() => setCreds(null)} />
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-pop">
            <h2 className="text-lg font-semibold">Demo creado ✔</h2>
            <p className="mt-1 text-sm text-slate-600">Comparte estos accesos con el cliente. La IA está <b>pausada</b> (no gasta tokens) hasta que la habilites desde la ficha de la organización.</p>
            <div className="mt-3 space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
              <div>Web: <span className="font-mono">tubot.cl/login</span></div>
              <div>Email: <span className="font-mono">{creds.email}</span></div>
              <div>
                Contraseña: {creds.tempPassword ? <span className="font-mono">{creds.tempPassword}</span> : <span className="text-slate-500">(el usuario ya tenía cuenta; usa su contraseña actual)</span>}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-amber-700">La contraseña se muestra una sola vez.</p>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setCreds(null)}>Listo</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
