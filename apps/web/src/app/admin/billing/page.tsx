"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast, type StatusKind } from "@/components/ui";

interface Invoice {
  id: string;
  number: string;
  organizationId: string;
  organizationName: string;
  status: string;
  currency: string;
  amountDue: string;
  createdAt: string;
  dueAt: string | null;
}
interface Org {
  id: string;
  name: string;
}
interface Provider {
  label: string;
  configured: boolean;
  webhookUrl?: string;
  storeId?: string | null;
  hasWebhookSecret?: boolean;
  baseUrl?: string;
  envVars: string[];
}

const KIND: Record<string, StatusKind> = { PAID: "connected", OPEN: "beta", DRAFT: "disconnected", VOID: "disconnected", UNCOLLECTIBLE: "attention" };

export default function BillingPage() {
  const toast = useToast();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [providers, setProviders] = useState<Record<string, Provider> | null>(null);
  const [form, setForm] = useState({ organizationId: "", amount: 0, currency: "CLP", concept: "Suscripción TuBot" });

  const load = useCallback(async () => {
    const [inv, o, prov] = await Promise.all([
      padmin<Invoice[]>("/platform/invoices"),
      padmin<Org[]>("/platform/organizations"),
      padmin<Record<string, Provider>>("/platform/billing/providers"),
    ]);
    setInvoices(inv);
    setOrgs(o);
    setProviders(prov);
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function emit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.organizationId) return toast.push("Elige una organización", "error");
    await padmin(`/platform/organizations/${form.organizationId}/invoices`, {
      method: "POST",
      body: JSON.stringify({ amount: form.amount, currency: form.currency, concept: form.concept }),
    });
    toast.push("Factura emitida", "ok");
    setForm({ ...form, amount: 0 });
    await load();
  }
  async function markPaid(id: string) {
    await padmin(`/platform/invoices/${id}/mark-paid`, { method: "POST" });
    toast.push("Factura marcada como pagada", "ok");
    await load();
  }

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Facturación" description="Facturas de la plataforma hacia los tenants. Emisión manual y confirmación de pago." />

      {providers && (
        <div className="mb-6 rounded-card border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 font-semibold text-navy-900">Proveedores de pago</h2>
          <p className="mb-3 text-xs text-slate-500">
            Las llaves secretas se cargan como variables de entorno en <b>Railway</b> (nunca en esta pantalla, por seguridad). Aquí ves el estado de conexión y la URL de webhook para pegar en cada proveedor.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(providers).map(([key, p]) => (
              <div key={key} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-navy-900">{p.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.configured ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                    {p.configured ? "configurado" : "falta configurar"}
                  </span>
                </div>
                {p.storeId && <p className="mt-1 text-xs text-slate-500">Store ID: <span className="font-mono">{p.storeId}</span></p>}
                {p.hasWebhookSecret === false && p.configured && <p className="mt-1 text-[11px] text-amber-700">Falta el secreto del webhook.</p>}
                {p.webhookUrl && (
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 truncate rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">{p.webhookUrl}</code>
                    <button
                      onClick={() => { void navigator.clipboard.writeText(p.webhookUrl!); toast.push("URL copiada", "ok"); }}
                      className="shrink-0 text-xs text-brand-600 hover:underline"
                    >
                      copiar
                    </button>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-slate-400">Variables en Railway: {p.envVars.join(", ")}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={emit} className="mb-6 flex flex-wrap items-end gap-3 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <label className="text-sm">
          Organización
          <select value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value })} className="mt-1 block w-56 rounded-lg border border-slate-300 bg-white px-3 py-2">
            <option value="">— elegir —</option>
            {orgs.map((o) => (<option key={o.id} value={o.id}>{o.name}</option>))}
          </select>
        </label>
        <label className="text-sm">
          Monto
          <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          Moneda
          <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2">
            <option value="CLP">CLP</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="flex-1 text-sm">
          Concepto
          <input value={form.concept} onChange={(e) => setForm({ ...form, concept: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <Button type="submit">Emitir factura</Button>
      </form>

      {!invoices ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Número</th>
                <th className="p-3">Organización</th>
                <th className="p-3">Monto</th>
                <th className="p-3">Estado</th>
                <th className="p-3">Fecha</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-sm text-slate-400">Sin facturas emitidas.</td></tr>
              )}
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-slate-100">
                  <td className="p-3 font-mono text-xs">{inv.number}</td>
                  <td className="p-3">{inv.organizationName}</td>
                  <td className="p-3">{inv.currency} {Number(inv.amountDue).toLocaleString("es-CL")}</td>
                  <td className="p-3"><StatusBadge kind={KIND[inv.status] ?? "disconnected"} label={inv.status.toLowerCase()} /></td>
                  <td className="p-3 text-xs text-slate-400">{new Date(inv.createdAt).toLocaleDateString("es-CL")}</td>
                  <td className="p-3">{inv.status !== "PAID" && <Button variant="secondary" onClick={() => void markPaid(inv.id)}>Marcar pagada</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
