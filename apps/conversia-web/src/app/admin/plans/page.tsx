"use client";
import { useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * Planes de la plataforma. Misma API que el super admin de TuBot
 * (GET /platform/plans, POST crear, PATCH /platform/plans/:id). El contrato de campos
 * replica `planFields` del backend (platform.controller): precios Decimal, interval,
 * trialDays, isPublic, order, active, y los JSON `limits` + `features`.
 *
 * Marca: mostramos SOLO los planes de Conversia filtrando por `plan.brand === "conversia"`
 * si el campo viene; si ningún plan trae brand, mostramos todos con el code a la vista.
 * El endpoint de escritura NO recibe `brand` (planFields no lo incluye), así que no lo enviamos.
 */
type Plan = {
  id: string;
  code: string;
  name: string;
  brand?: string | null;
  priceClp: number | string;
  priceUsd: number | string;
  priceClpYearly: number | string | null;
  priceUsdYearly: number | string | null;
  interval: "monthly" | "yearly";
  trialDays: number;
  isPublic: boolean;
  order: number;
  active: boolean;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
};

/** Borrador editable de un plan. Los campos clave de features/limits se exponen con inputs;
 *  el resto de cada JSON se edita como texto (el JSON de "otros" se fusiona al guardar). */
type Draft = {
  name: string;
  priceClp: number;
  priceUsd: number;
  priceClpYearly: number;
  priceUsdYearly: number;
  interval: "monthly" | "yearly";
  trialDays: number;
  isPublic: boolean;
  order: number;
  active: boolean;
  // features clave
  templateMessages: number;
  whatsappTemplates: boolean;
  serviceDebitsWallet: boolean;
  // limits clave
  contactsMonthly: number;
  // resto de los JSON como texto
  featuresJson: string;
  limitsJson: string;
};

type NewPlan = {
  code: string;
  name: string;
  priceClp: number;
  priceUsd: number;
  priceClpYearly: number;
  priceUsdYearly: number;
  interval: "monthly" | "yearly";
  trialDays: number;
  order: number;
  isPublic: boolean;
  templateMessages: number;
  whatsappTemplates: boolean;
  serviceDebitsWallet: boolean;
  contactsMonthly: number;
};
const EMPTY_NEW: NewPlan = { code: "conversia_", name: "", priceClp: 0, priceUsd: 0, priceClpYearly: 0, priceUsdYearly: 0, interval: "monthly", trialDays: 0, order: 10, isPublic: true, templateMessages: 1000, whatsappTemplates: true, serviceDebitsWallet: false, contactsMonthly: 0 };

const KNOWN_FEATURE_KEYS = ["templateMessages", "whatsappTemplates", "serviceDebitsWallet"];
const KNOWN_LIMIT_KEYS = ["contactsMonthly"];

/** Separa las claves conocidas del resto; el resto se devuelve como JSON legible. */
function restJson(obj: Record<string, unknown>, known: string[]): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!known.includes(k)) rest[k] = v;
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "";
}

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newPlan, setNewPlan] = useState<NewPlan>({ ...EMPTY_NEW });

  async function load() {
    try {
      const all = await padmin<Plan[]>("/platform/plans");
      // Filtra por marca conversia si el campo existe; si NINGÚN plan trae brand, muestra todos.
      const anyBrand = all.some((p) => typeof p.brand === "string" && p.brand);
      const rows = anyBrand ? all.filter((p) => p.brand === "conversia") : all;
      setPlans(rows);
      const d: Record<string, Draft> = {};
      for (const p of rows) {
        const features = (p.features ?? {}) as Record<string, unknown>;
        const limits = (p.limits ?? {}) as Record<string, unknown>;
        d[p.id] = {
          name: p.name,
          priceClp: Number(p.priceClp),
          priceUsd: Number(p.priceUsd),
          priceClpYearly: Number(p.priceClpYearly ?? 0),
          priceUsdYearly: Number(p.priceUsdYearly ?? 0),
          interval: p.interval === "yearly" ? "yearly" : "monthly",
          trialDays: Number(p.trialDays ?? 0),
          isPublic: Boolean(p.isPublic),
          order: Number(p.order ?? 0),
          active: Boolean(p.active),
          templateMessages: Number(features.templateMessages ?? 0),
          whatsappTemplates: Boolean(features.whatsappTemplates),
          serviceDebitsWallet: Boolean(features.serviceDebitsWallet),
          contactsMonthly: Number(limits.contactsMonthly ?? 0),
          featuresJson: restJson(features, KNOWN_FEATURE_KEYS),
          limitsJson: restJson(limits, KNOWN_LIMIT_KEYS),
        };
      }
      setDrafts(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patch(id: string, fn: (d: Draft) => Draft) {
    setDrafts((prev) => ({ ...prev, [id]: fn(prev[id]) }));
  }

  /** Reconstruye features/limits: claves conocidas + el JSON de "otros" (si es válido). */
  function buildJson(d: Draft): { features: Record<string, unknown>; limits: Record<string, unknown> } | null {
    let restF: Record<string, unknown> = {};
    let restL: Record<string, unknown> = {};
    try {
      if (d.featuresJson.trim()) restF = JSON.parse(d.featuresJson);
      if (d.limitsJson.trim()) restL = JSON.parse(d.limitsJson);
    } catch {
      return null;
    }
    return {
      features: { ...restF, templateMessages: d.templateMessages, whatsappTemplates: d.whatsappTemplates, serviceDebitsWallet: d.serviceDebitsWallet },
      limits: { ...restL, contactsMonthly: d.contactsMonthly },
    };
  }

  async function save(p: Plan) {
    const d = drafts[p.id];
    if (!d) return;
    const json = buildJson(d);
    if (!json) {
      setError(`El JSON de features o limits del plan ${p.name} no es válido.`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await padmin(`/platform/plans/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: d.name,
          priceClp: d.priceClp,
          priceUsd: d.priceUsd,
          priceClpYearly: d.priceClpYearly || null,
          priceUsdYearly: d.priceUsdYearly || null,
          interval: d.interval,
          trialDays: d.trialDays,
          isPublic: d.isPublic,
          order: d.order,
          active: d.active,
          features: json.features,
          limits: json.limits,
        }),
      });
      setNotice(`Plan ${d.name} guardado.`);
      await load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!newPlan.code.trim() || !newPlan.name.trim()) {
      setError("Código y nombre son obligatorios.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await padmin("/platform/plans", {
        method: "POST",
        body: JSON.stringify({
          code: newPlan.code.trim(),
          name: newPlan.name.trim(),
          priceClp: newPlan.priceClp,
          priceUsd: newPlan.priceUsd,
          priceClpYearly: newPlan.priceClpYearly || null,
          priceUsdYearly: newPlan.priceUsdYearly || null,
          interval: newPlan.interval,
          trialDays: newPlan.trialDays,
          isPublic: newPlan.isPublic,
          order: newPlan.order,
          features: { templateMessages: newPlan.templateMessages, whatsappTemplates: newPlan.whatsappTemplates, serviceDebitsWallet: newPlan.serviceDebitsWallet },
          limits: { contactsMonthly: newPlan.contactsMonthly },
        }),
      });
      setNotice(`Plan ${newPlan.name} creado.`);
      setNewPlan({ ...EMPTY_NEW });
      setShowNew(false);
      await load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "9px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
  const label: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)" };
  const check: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-dim)" };
  const clp = (n: number) => `$${Number(n).toLocaleString("es-CL")}`;

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Planes</h1>
      <p className="text-dim" style={{ fontSize: 14, margin: "0 0 18px" }}>Crea y edita los planes de Conversia: precios (mensual/anual), límites y capacidades. El precio anual es opcional (null = no se ofrece).</p>

      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}
      {notice ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{notice}</p> : null}

      {showNew ? (
        <form onSubmit={createPlan} className="card" style={{ padding: 18, marginBottom: 18 }}>
          <h2 className="display" style={{ fontSize: 17, margin: "0 0 12px" }}>Nuevo plan</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label style={label}>Código (único)
              <input style={{ ...field, fontFamily: "ui-monospace, monospace" }} value={newPlan.code} onChange={(e) => setNewPlan({ ...newPlan, code: e.target.value })} placeholder="conversia_starter" required />
            </label>
            <label style={label}>Nombre
              <input style={field} value={newPlan.name} onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })} placeholder="Starter" required />
            </label>
            <label style={label}>Precio CLP / mes
              <input style={field} type="number" min={0} value={newPlan.priceClp} onChange={(e) => setNewPlan({ ...newPlan, priceClp: Number(e.target.value) })} />
            </label>
            <label style={label}>Precio USD / mes
              <input style={field} type="number" min={0} step="0.01" value={newPlan.priceUsd} onChange={(e) => setNewPlan({ ...newPlan, priceUsd: Number(e.target.value) })} />
            </label>
            <label style={label}>Precio CLP / año (opcional)
              <input style={field} type="number" min={0} value={newPlan.priceClpYearly} onChange={(e) => setNewPlan({ ...newPlan, priceClpYearly: Number(e.target.value) })} />
            </label>
            <label style={label}>Precio USD / año (opcional)
              <input style={field} type="number" min={0} step="0.01" value={newPlan.priceUsdYearly} onChange={(e) => setNewPlan({ ...newPlan, priceUsdYearly: Number(e.target.value) })} />
            </label>
            <label style={label}>Cadencia por defecto
              <select style={field} value={newPlan.interval} onChange={(e) => setNewPlan({ ...newPlan, interval: e.target.value as NewPlan["interval"] })}>
                <option value="monthly">Mensual</option>
                <option value="yearly">Anual</option>
              </select>
            </label>
            <label style={label}>Días de prueba
              <input style={field} type="number" min={0} max={90} value={newPlan.trialDays} onChange={(e) => setNewPlan({ ...newPlan, trialDays: Number(e.target.value) })} />
            </label>
            <label style={label}>Mensajes de plantilla incluidos (−1 = ilimitado)
              <input style={field} type="number" value={newPlan.templateMessages} onChange={(e) => setNewPlan({ ...newPlan, templateMessages: Number(e.target.value) })} />
            </label>
            <label style={label}>Contactos / mes (0 = ilimitado)
              <input style={field} type="number" min={0} value={newPlan.contactsMonthly} onChange={(e) => setNewPlan({ ...newPlan, contactsMonthly: Number(e.target.value) })} />
            </label>
            <label style={label}>Orden
              <input style={field} type="number" value={newPlan.order} onChange={(e) => setNewPlan({ ...newPlan, order: Number(e.target.value) })} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 14 }}>
            <label style={check}><input type="checkbox" checked={newPlan.whatsappTemplates} onChange={(e) => setNewPlan({ ...newPlan, whatsappTemplates: e.target.checked })} /> Plantillas WhatsApp</label>
            <label style={check}><input type="checkbox" checked={newPlan.serviceDebitsWallet} onChange={(e) => setNewPlan({ ...newPlan, serviceDebitsWallet: e.target.checked })} /> Servicios descuentan de la bolsa</label>
            <label style={check}><input type="checkbox" checked={newPlan.isPublic} onChange={(e) => setNewPlan({ ...newPlan, isPublic: e.target.checked })} /> Público (cotizable)</label>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn-accent" type="submit" disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>Crear plan</button>
            <button type="button" onClick={() => { setShowNew(false); setNewPlan({ ...EMPTY_NEW }); }} className="text-dim" style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 10, padding: "8px 14px", fontSize: 13 }}>Cancelar</button>
          </div>
          <p className="text-dim" style={{ fontSize: 11, margin: "12px 0 0" }}>Por convención, los planes de Conversia usan un código que empieza con &quot;conversia&quot;.</p>
        </form>
      ) : (
        <button className="btn-accent" onClick={() => setShowNew(true)} style={{ marginBottom: 18 }}>+ Crear plan</button>
      )}

      {!plans ? (
        <p className="text-dim">Cargando…</p>
      ) : plans.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Aún no hay planes de Conversia.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plans.map((p) => {
            const d = drafts[p.id];
            if (!d) return null;
            const isOpen = open === p.id;
            return (
              <div key={p.id} className="card" style={{ padding: 16 }}>
                <div onClick={() => setOpen(isOpen ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", cursor: "pointer" }}>
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{p.name}</p>
                    <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{p.code}{p.brand ? ` · ${p.brand}` : ""}</p>
                  </div>
                  <span className="text-dim" style={{ fontSize: 13 }}>{clp(Number(p.priceClp))} · US${Number(p.priceUsd).toFixed(2)}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: p.active ? "var(--ok)" : "var(--ink-dim)" }}>● {p.active ? "Activo" : "Inactivo"}</span>
                  {!p.isPublic ? <span className="text-dim" style={{ fontSize: 11 }}>privado</span> : null}
                  <span className="text-dim" style={{ fontSize: 18, lineHeight: 1 }}>{isOpen ? "▾" : "▸"}</span>
                </div>

                {isOpen ? (
                  <div style={{ marginTop: 16, borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                      <label style={label}>Nombre
                        <input style={field} value={d.name} onChange={(e) => patch(p.id, (x) => ({ ...x, name: e.target.value }))} />
                      </label>
                      <label style={label}>Precio CLP / mes
                        <input style={field} type="number" min={0} value={d.priceClp} onChange={(e) => patch(p.id, (x) => ({ ...x, priceClp: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Precio USD / mes
                        <input style={field} type="number" min={0} step="0.01" value={d.priceUsd} onChange={(e) => patch(p.id, (x) => ({ ...x, priceUsd: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Precio CLP / año (opcional)
                        <input style={field} type="number" min={0} value={d.priceClpYearly} onChange={(e) => patch(p.id, (x) => ({ ...x, priceClpYearly: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Precio USD / año (opcional)
                        <input style={field} type="number" min={0} step="0.01" value={d.priceUsdYearly} onChange={(e) => patch(p.id, (x) => ({ ...x, priceUsdYearly: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Cadencia por defecto
                        <select style={field} value={d.interval} onChange={(e) => patch(p.id, (x) => ({ ...x, interval: e.target.value as Draft["interval"] }))}>
                          <option value="monthly">Mensual</option>
                          <option value="yearly">Anual</option>
                        </select>
                      </label>
                      <label style={label}>Días de prueba
                        <input style={field} type="number" min={0} max={90} value={d.trialDays} onChange={(e) => patch(p.id, (x) => ({ ...x, trialDays: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Orden
                        <input style={field} type="number" value={d.order} onChange={(e) => patch(p.id, (x) => ({ ...x, order: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Mensajes de plantilla incluidos (−1 = ilimitado)
                        <input style={field} type="number" value={d.templateMessages} onChange={(e) => patch(p.id, (x) => ({ ...x, templateMessages: Number(e.target.value) }))} />
                      </label>
                      <label style={label}>Contactos / mes (0 = ilimitado)
                        <input style={field} type="number" min={0} value={d.contactsMonthly} onChange={(e) => patch(p.id, (x) => ({ ...x, contactsMonthly: Number(e.target.value) }))} />
                      </label>
                    </div>

                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 14 }}>
                      <label style={check}><input type="checkbox" checked={d.whatsappTemplates} onChange={(e) => patch(p.id, (x) => ({ ...x, whatsappTemplates: e.target.checked }))} /> Plantillas WhatsApp</label>
                      <label style={check}><input type="checkbox" checked={d.serviceDebitsWallet} onChange={(e) => patch(p.id, (x) => ({ ...x, serviceDebitsWallet: e.target.checked }))} /> Servicios descuentan de la bolsa</label>
                      <label style={check}><input type="checkbox" checked={d.isPublic} onChange={(e) => patch(p.id, (x) => ({ ...x, isPublic: e.target.checked }))} /> Público (cotizable)</label>
                      <label style={check}><input type="checkbox" checked={d.active} onChange={(e) => patch(p.id, (x) => ({ ...x, active: e.target.checked }))} /> Activo</label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
                      <label style={label}>Resto de <code>features</code> (JSON)
                        <textarea style={{ ...field, minHeight: 90, fontFamily: "ui-monospace, monospace", resize: "vertical" }} value={d.featuresJson} onChange={(e) => patch(p.id, (x) => ({ ...x, featuresJson: e.target.value }))} placeholder="{ }" />
                      </label>
                      <label style={label}>Resto de <code>limits</code> (JSON)
                        <textarea style={{ ...field, minHeight: 90, fontFamily: "ui-monospace, monospace", resize: "vertical" }} value={d.limitsJson} onChange={(e) => patch(p.id, (x) => ({ ...x, limitsJson: e.target.value }))} placeholder="{ }" />
                      </label>
                    </div>
                    <p className="text-dim" style={{ fontSize: 11, margin: "8px 0 0" }}>Las claves clave de arriba se fusionan sobre este JSON al guardar (no las dupliques aquí).</p>

                    <button className="btn-accent" onClick={() => save(p)} disabled={busy} style={{ marginTop: 16, opacity: busy ? 0.6 : 1 }}>Guardar cambios</button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
