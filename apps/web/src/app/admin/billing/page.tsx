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
  const [providers, setProviders] = useState<any | null>(null);
  const [form, setForm] = useState({ organizationId: "", amount: 0, currency: "CLP", concept: "Suscripción TuBot" });
  const [flowForm, setFlowForm] = useState({ apiKey: "", secretKey: "", baseUrl: "" });
  const [lsForm, setLsForm] = useState({ apiKey: "", storeId: "", webhookSecret: "" });
  const [saving, setSaving] = useState(false);
  const [flowTest, setFlowTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function testFlow() {
    setTesting(true);
    setFlowTest(null);
    try {
      const r = await padmin<{ ok: boolean; detail: string }>("/platform/billing/flow/test", { method: "POST" });
      setFlowTest(r);
    } catch (e) {
      setFlowTest({ ok: false, detail: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const load = useCallback(async () => {
    const [inv, o, prov] = await Promise.all([
      padmin<Invoice[]>("/platform/invoices"),
      padmin<Org[]>("/platform/organizations"),
      padmin<any>("/platform/billing/providers"),
    ]);
    setInvoices(inv);
    setOrgs(o);
    setProviders(prov);
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function saveProvider(provider: "flow" | "lemonsqueezy") {
    setSaving(true);
    try {
      const payload =
        provider === "flow"
          ? { provider, flow: { apiKey: flowForm.apiKey || undefined, secretKey: flowForm.secretKey || undefined, baseUrl: flowForm.baseUrl || undefined } }
          : { provider, lemonsqueezy: { apiKey: lsForm.apiKey || undefined, storeId: lsForm.storeId || undefined, webhookSecret: lsForm.webhookSecret || undefined } };
      await padmin("/platform/billing/settings", { method: "POST", body: JSON.stringify(payload) });
      toast.push("Credenciales guardadas ✔", "ok");
      setFlowForm({ apiKey: "", secretKey: "", baseUrl: "" });
      setLsForm({ apiKey: "", storeId: "", webhookSecret: "" });
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

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

  const badge = (configured: boolean, source: string | null) => (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${configured ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
      {configured ? `configurado${source ? ` · ${source}` : ""}` : "falta configurar"}
    </span>
  );
  const copyable = (url?: string) =>
    url ? (
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">{url}</code>
        <button onClick={() => { void navigator.clipboard.writeText(url); toast.push("URL copiada", "ok"); }} className="shrink-0 text-xs text-brand-600 hover:underline">copiar</button>
      </div>
    ) : null;

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Facturación y pagos" description="Configura las pasarelas, emite facturas y confirma pagos." />

      {/* Configuración de pasarelas */}
      {providers && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          {/* Flow */}
          <div className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold text-navy-900">{providers.flow.label}</h2>
              {badge(providers.flow.configured, providers.flow.source)}
            </div>
            <p className="mb-3 text-xs text-slate-500">Pega tus credenciales de Flow. Se guardan cifradas; no se muestran de vuelta (deja vacío para no cambiar).</p>
            <div className="space-y-2">
              <input type="password" value={flowForm.apiKey} onChange={(e) => setFlowForm({ ...flowForm, apiKey: e.target.value })} placeholder="API Key" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" autoComplete="off" />
              <input type="password" value={flowForm.secretKey} onChange={(e) => setFlowForm({ ...flowForm, secretKey: e.target.value })} placeholder="Secret Key" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" autoComplete="off" />
              <input value={flowForm.baseUrl} onChange={(e) => setFlowForm({ ...flowForm, baseUrl: e.target.value })} placeholder={`Base URL (actual: ${providers.flow.baseUrl})`} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <p className="text-[11px] text-slate-400">Producción: https://www.flow.cl/api · Sandbox: https://sandbox.flow.cl/api</p>
            </div>
            <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] text-slate-500">
              ✓ Flow no requiere configurar webhook en su panel: la URL de confirmación se envía automáticamente en cada pago. Con las dos llaves basta.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button disabled={saving} onClick={() => void saveProvider("flow")}>Guardar Flow</Button>
              <Button variant="secondary" disabled={testing || !providers.flow.configured} onClick={() => void testFlow()}>
                {testing ? "Probando…" : "Probar credenciales"}
              </Button>
            </div>
            {flowTest && (
              <p className={`mt-2 rounded-lg px-2 py-1.5 text-[12px] ${flowTest.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                {flowTest.ok ? "✓" : "✖"} {flowTest.detail}
              </p>
            )}
          </div>

          {/* Lemon Squeezy */}
          <div className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold text-navy-900">{providers.lemonSqueezy.label}</h2>
              {badge(providers.lemonSqueezy.configured, providers.lemonSqueezy.source)}
            </div>
            <p className="mb-3 text-xs text-slate-500">Para USD/internacional (lo habilitas después). {providers.lemonSqueezy.storeId ? `Store: ${providers.lemonSqueezy.storeId}` : ""}</p>
            <div className="space-y-2">
              <input type="password" value={lsForm.apiKey} onChange={(e) => setLsForm({ ...lsForm, apiKey: e.target.value })} placeholder="API Key" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" autoComplete="off" />
              <input value={lsForm.storeId} onChange={(e) => setLsForm({ ...lsForm, storeId: e.target.value })} placeholder="Store ID" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <input type="password" value={lsForm.webhookSecret} onChange={(e) => setLsForm({ ...lsForm, webhookSecret: e.target.value })} placeholder="Webhook Signing Secret" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" autoComplete="off" />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Pega esta URL en Lemon Squeezy → Settings → Webhooks (con el mismo Signing Secret):</p>
            {copyable(providers.lemonSqueezy.webhookUrl)}
            <Button className="mt-3" variant="secondary" disabled={saving} onClick={() => void saveProvider("lemonsqueezy")}>Guardar Lemon Squeezy</Button>
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
