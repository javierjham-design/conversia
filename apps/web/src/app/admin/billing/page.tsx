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

const KIND: Record<string, StatusKind> = { PAID: "connected", OPEN: "beta", DRAFT: "disconnected", VOID: "disconnected", UNCOLLECTIBLE: "attention" };

export default function BillingPage() {
  const toast = useToast();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [form, setForm] = useState({ organizationId: "", amount: 0, currency: "CLP", concept: "Suscripción TuBot" });

  const load = useCallback(async () => {
    const [inv, o] = await Promise.all([padmin<Invoice[]>("/platform/invoices"), padmin<Org[]>("/platform/organizations")]);
    setInvoices(inv);
    setOrgs(o);
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
        <div className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-card">
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
