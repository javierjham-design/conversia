"use client";
import { useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * Cupones de descuento de la plataforma. Misma API que el super admin de TuBot
 * (GET /platform/coupons, POST crear, PATCH :id toggle active, DELETE :id), con el estilo
 * "Nocturna" de la consola de Conversia. El PATCH del backend solo admite { active }.
 * discountValue llega como string (Decimal) → se normaliza a número en pantalla.
 */
type Coupon = {
  id: string;
  code: string;
  description: string | null;
  discountType: "PERCENT" | "FIXED";
  discountValue: number | string;
  currency: string | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
};

type Form = { code: string; description: string; discountType: "PERCENT" | "FIXED"; discountValue: string; currency: "CLP" | "USD"; maxRedemptions: string; expiresAt: string };
const EMPTY: Form = { code: "", description: "", discountType: "PERCENT", discountValue: "", currency: "CLP", maxRedemptions: "", expiresAt: "" };

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({ ...EMPTY });
  const [busy, setBusy] = useState(false);

  const load = () =>
    padmin<Coupon[]>("/platform/coupons")
      .then(setCoupons)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await padmin("/platform/coupons", {
        method: "POST",
        body: JSON.stringify({
          code: form.code.trim(),
          description: form.description.trim() || undefined,
          discountType: form.discountType,
          discountValue: Number(form.discountValue),
          currency: form.discountType === "FIXED" ? form.currency : undefined,
          maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : undefined,
          expiresAt: form.expiresAt || undefined,
        }),
      });
      setForm({ ...EMPTY });
      setNotice("Cupón creado.");
      await load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: Coupon) {
    setError(null);
    try {
      await padmin(`/platform/coupons/${c.id}`, { method: "PATCH", body: JSON.stringify({ active: !c.active }) });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(c: Coupon) {
    if (!confirm(`¿Eliminar el cupón ${c.code}?`)) return;
    setError(null);
    try {
      await padmin(`/platform/coupons/${c.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const discountLabel = (c: Coupon) =>
    c.discountType === "PERCENT" ? `${Number(c.discountValue)}%` : `${c.currency ?? "CLP"} ${Number(c.discountValue).toLocaleString("es-CL")}`;

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Cupones</h1>
      <p className="text-dim" style={{ fontSize: 14, margin: "0 0 18px" }}>Descuentos para campañas y landings. Se aplican en el checkout del tenant.</p>

      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}
      {notice ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{notice}</p> : null}

      <form onSubmit={create} className="card" style={{ padding: 18, marginBottom: 18 }}>
        <h2 className="display" style={{ fontSize: 17, margin: "0 0 12px" }}>Nuevo cupón</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Código
            <input style={{ ...field, fontFamily: "ui-monospace, monospace" }} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="VERANO2026" required />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Tipo
            <select style={field} value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value as Form["discountType"] })}>
              <option value="PERCENT">Porcentaje %</option>
              <option value="FIXED">Monto fijo</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Valor
            <input style={field} type="number" min={1} value={form.discountValue} onChange={(e) => setForm({ ...form, discountValue: e.target.value })} required />
          </label>
          {form.discountType === "FIXED" ? (
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Moneda
              <select style={field} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Form["currency"] })}>
                <option value="CLP">CLP</option>
                <option value="USD">USD</option>
              </select>
            </label>
          ) : null}
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Máx. usos
            <input style={field} type="number" min={1} value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} placeholder="∞" />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Expira
            <input style={field} type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)", gridColumn: "1 / -1" }}>Descripción (opcional)
            <input style={field} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Campaña de verano" />
          </label>
        </div>
        <button className="btn-accent" type="submit" disabled={busy || !form.code.trim() || !form.discountValue} style={{ marginTop: 16, opacity: busy ? 0.6 : 1 }}>Crear cupón</button>
      </form>

      {!coupons ? (
        <p className="text-dim">Cargando…</p>
      ) : coupons.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Aún no hay cupones.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {coupons.map((c) => (
            <div key={c.id} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 15, fontFamily: "ui-monospace, monospace" }}>{c.code}</p>
                {c.description ? <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{c.description}</p> : null}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{discountLabel(c)}</span>
              <span className="text-dim" style={{ fontSize: 12, minWidth: 80 }}>
                {c.timesRedeemed}{c.maxRedemptions != null ? ` / ${c.maxRedemptions}` : " usos"}
              </span>
              <span className="text-dim" style={{ fontSize: 12, minWidth: 90 }}>{c.expiresAt ? `vence ${new Date(c.expiresAt).toLocaleDateString("es-CL")}` : "sin vencimiento"}</span>
              <button onClick={() => toggle(c)} style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 600, color: c.active ? "var(--ok)" : "var(--ink-dim)" }}>
                ● {c.active ? "Activo" : "Inactivo"}
              </button>
              <button onClick={() => remove(c)} style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--danger)", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12 }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
