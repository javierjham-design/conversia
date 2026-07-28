"use client";

import { useState } from "react";

/**
 * Botón que abre un formulario de solicitud de demo (público). Envía a
 * /public/demo-request (vía el proxy /backend). Usado en la landing en los
 * botones "Empezar" y "Solicitar demo".
 */
export function DemoCta({ label, planCode, className }: { label: string; planCode?: string; className?: string }) {
  const [open, setOpen] = useState(false);
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

  function close() {
    setOpen(false);
    setTimeout(() => {
      setSent(false);
      setError(null);
      setForm({ name: "", email: "", company: "", phone: "" });
    }, 200);
  }

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-navy-950/60" onClick={close} />
          <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-pop">
            {sent ? (
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-2xl">✓</div>
                <h3 className="text-lg font-semibold text-navy-900">¡Recibimos tu solicitud!</h3>
                <p className="mt-1 text-sm text-slate-600">Te contactaremos muy pronto para coordinar tu demo de TuBot.</p>
                <button onClick={close} className="mt-4 rounded-lg bg-brand-600 px-5 py-2 font-medium text-white hover:bg-brand-700">Listo</button>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <div>
                  <h3 className="text-lg font-semibold text-navy-900">Solicita tu demo</h3>
                  <p className="text-sm text-slate-500">{planCode ? `Plan de interés: ${planCode}. ` : ""}Déjanos tus datos y te contactamos.</p>
                </div>
                <input required placeholder="Tu nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input placeholder="Empresa / negocio" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <input placeholder="Teléfono / WhatsApp (opcional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                {error && <p className="text-sm text-red-600">{error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={close} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancelar</button>
                  <button type="submit" disabled={loading} className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                    {loading ? "Enviando…" : "Solicitar demo"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
