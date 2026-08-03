"use client";

import { useState } from "react";
import Link from "next/link";

/** Formulario de solicitud de demo (página /demo). Envía a /public/demo-request. */
export function DemoForm({ planCode }: { planCode?: string }) {
  const [form, setForm] = useState({ name: "", email: "", company: "", phone: "" });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/backend/public/demo-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, planInterest: planCode }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as any).message ?? "No se pudo enviar. Intenta de nuevo.");
      }
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-3xl">✓</div>
        <h2 className="text-xl font-semibold text-navy-900">¡Recibimos tu solicitud!</h2>
        <p className="mt-2 text-ink-muted">Te contactaremos muy pronto para coordinar tu demo de TuBot y activar tu acceso.</p>
        <Link href="/" className="mt-6 inline-block rounded-lg bg-brand-600 px-6 py-3 font-medium text-white hover:bg-brand-700">
          Volver al inicio
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {planCode && (
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">Plan de interés: <b>{planCode}</b></p>
      )}
      <label className="block text-sm font-medium text-navy-900">
        Nombre
        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Tu nombre" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2.5" />
      </label>
      <label className="block text-sm font-medium text-navy-900">
        Email
        <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="tucorreo@empresa.cl" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2.5" />
      </label>
      <label className="block text-sm font-medium text-navy-900">
        Empresa / negocio
        <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Nombre de tu negocio" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2.5" />
      </label>
      <label className="block text-sm font-medium text-navy-900">
        Teléfono / WhatsApp <span className="font-normal text-ink-subtle">(opcional)</span>
        <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+56 9 …" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2.5" />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-600 px-6 py-3 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {loading ? "Enviando…" : "Solicitar mi demo"}
      </button>
      <p className="text-center text-xs text-ink-subtle">Sin compromiso. Te contactamos para activar tu acceso.</p>
    </form>
  );
}
