"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast } from "@/components/ui";

interface Coupon {
  id: string;
  code: string;
  description: string | null;
  discountType: "PERCENT" | "FIXED";
  discountValue: string;
  currency: string | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

const EMPTY = { code: "", description: "", discountType: "PERCENT", discountValue: "", currency: "CLP", maxRedemptions: "", expiresAt: "" };

export default function CouponsPage() {
  const toast = useToast();
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  const load = useCallback(async () => {
    setCoupons(await padmin<Coupon[]>("/platform/coupons"));
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await padmin("/platform/coupons", {
        method: "POST",
        body: JSON.stringify({
          code: form.code,
          description: form.description || undefined,
          discountType: form.discountType,
          discountValue: Number(form.discountValue),
          currency: form.discountType === "FIXED" ? form.currency : undefined,
          maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
          expiresAt: form.expiresAt || undefined,
        }),
      });
      setForm({ ...EMPTY });
      toast.push("Cupón creado", "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }
  async function toggle(c: Coupon) {
    await padmin(`/platform/coupons/${c.id}`, { method: "PATCH", body: JSON.stringify({ active: !c.active }) });
    await load();
  }
  async function remove(c: Coupon) {
    if (!window.confirm(`¿Eliminar el cupón ${c.code}?`)) return;
    await padmin(`/platform/coupons/${c.id}`, { method: "DELETE" });
    await load();
  }

  const discountLabel = (c: Coupon) =>
    c.discountType === "PERCENT" ? `${Number(c.discountValue)}%` : `${c.currency} ${Number(c.discountValue).toLocaleString("es-CL")}`;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <PageHeader title="Cupones" description="Descuentos para campañas y landings. Se aplican en el checkout del tenant." />

      <form onSubmit={create} className="mb-6 flex flex-wrap items-end gap-2 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <label className="text-sm">
          Código
          <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="VERANO2026" className="mt-1 block w-40 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm" />
        </label>
        <label className="text-sm">
          Tipo
          <select value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value })} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="PERCENT">Porcentaje %</option>
            <option value="FIXED">Monto fijo</option>
          </select>
        </label>
        <label className="text-sm">
          Valor
          <input required type="number" min="1" value={form.discountValue} onChange={(e) => setForm({ ...form, discountValue: e.target.value })} className="mt-1 block w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        {form.discountType === "FIXED" && (
          <label className="text-sm">
            Moneda
            <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="CLP">CLP</option>
              <option value="USD">USD</option>
            </select>
          </label>
        )}
        <label className="text-sm">
          Máx. usos
          <input type="number" min="1" value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} placeholder="∞" className="mt-1 block w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          Expira
          <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <Button type="submit">Crear cupón</Button>
      </form>

      {!coupons ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="overflow-hidden rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Código</th>
                <th className="p-3">Descuento</th>
                <th className="p-3">Usos</th>
                <th className="p-3">Expira</th>
                <th className="p-3">Estado</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {coupons.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-400">Sin cupones aún.</td>
                </tr>
              ) : (
                coupons.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="p-3">
                      <div className="font-mono font-medium">{c.code}</div>
                      {c.description && <div className="text-xs text-slate-400">{c.description}</div>}
                    </td>
                    <td className="p-3">{discountLabel(c)}</td>
                    <td className="p-3 text-slate-500">
                      {c.timesRedeemed}
                      {c.maxRedemptions != null ? ` / ${c.maxRedemptions}` : ""}
                    </td>
                    <td className="p-3 text-slate-400">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString("es-CL") : "—"}</td>
                    <td className="p-3">
                      <button onClick={() => void toggle(c)}>
                        <StatusBadge kind={c.active ? "connected" : "disconnected"} label={c.active ? "activo" : "inactivo"} />
                      </button>
                    </td>
                    <td className="p-3 text-right">
                      <button onClick={() => void remove(c)} className="text-xs text-slate-300 hover:text-red-500">Eliminar</button>
                    </td>
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
