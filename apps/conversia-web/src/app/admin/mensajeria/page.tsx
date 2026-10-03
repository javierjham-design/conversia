"use client";
import { useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * Super admin de Conversia — "Mensajería y costos". Reúne en una sola página las palancas
 * globales de plataforma que viven en platform_settings: tarifas/modelo de costos (IA + Meta
 * por mensaje + tipo de cambio), límites de mensajería (fusible global + default por tenant),
 * pesos de la bolsa prepagada y el precio de activación de plantillas. Cada sección carga su
 * dato, muestra los valores vigentes y ofrece un form con Guardar + mensaje de éxito/error.
 * Todo contra la API de plataforma (padmin) — nunca fetch directo.
 */

// ------------------------------- Tipos de la API -------------------------------
interface ModelPricing { inputPerMTok: number; outputPerMTok: number }
interface WaRates { marketing: number; utility: number; authentication: number; service: number }
interface CostModel { models: Record<string, ModelPricing>; whatsapp: Record<string, WaRates>; usdToClp?: number }
interface Limits {
  global: number;
  perTenantDefault: number;
  todayGlobal: number;
  fuseTripped: boolean;
  clpPerMsg: { marketing: number; utility: number };
}
interface Weights { utility: number; authentication: number; marketing: number }
interface TemplatesPricing { priceClp: number | null; priceUsd: number | null }

type Status = { kind: "ok" | "error"; text: string } | null;

const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;
const errMsg = (e: unknown) => (e instanceof PlatformApiError ? e.message : (e as Error).message);

// Estilos compartidos (design system Nocturna, vars CSS).
const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  marginTop: 5,
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--surface-solid)",
  color: "var(--ink)",
  fontSize: 14,
};
const numField: React.CSSProperties = { ...field, width: 140 };
const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block" };
const sectionTitle: React.CSSProperties = { fontSize: 18, margin: "0 0 4px" };
const sectionHint: React.CSSProperties = { margin: "0 0 14px", fontSize: 13 };

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <p style={{ margin: "12px 0 0", fontSize: 13, color: status.kind === "ok" ? "var(--ok)" : "var(--danger)" }}>
      {status.text}
    </p>
  );
}

export default function MensajeriaPage() {
  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Mensajería y costos</h1>
      <p className="text-dim" style={{ margin: "0 0 22px", fontSize: 14 }}>
        Palancas globales de plataforma: tarifas y modelo de costos, fusible y topes de mensajería,
        pesos de la bolsa prepagada y precio de activación de plantillas. Afectan la facturación real.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <CostModelSection />
        <MessagingLimitsSection />
        <WalletWeightsSection />
        <TemplatesPricingSection />
      </div>
    </div>
  );
}

// =========================================================================
// 1) Tarifas y modelo de costos — GET /cost-model · PATCH /cost-settings
// =========================================================================
function CostModelSection() {
  const [cost, setCost] = useState<CostModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fx, setFx] = useState<number>(0);
  const [rates, setRates] = useState<Record<string, WaRates>>({});
  const [newCountry, setNewCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const load = () =>
    padmin<CostModel>("/platform/cost-model")
      .then((c) => {
        setCost(c);
        setFx(c.usdToClp ?? 0);
        setRates(JSON.parse(JSON.stringify(c.whatsapp ?? {})) as Record<string, WaRates>);
      })
      .catch((e) => setLoadError(errMsg(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setRate(cc: string, key: keyof WaRates, val: number) {
    setRates((prev) => ({
      ...prev,
      [cc]: { ...(prev[cc] ?? { marketing: 0, utility: 0, authentication: 0, service: 0 }), [key]: val },
    }));
  }
  function addCountry() {
    const cc = newCountry.trim().toUpperCase();
    if (!cc || rates[cc]) return;
    setRates((prev) => ({ ...prev, [cc]: { marketing: 0, utility: 0, authentication: 0, service: 0 } }));
    setNewCountry("");
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      await padmin("/platform/cost-settings", {
        method: "PATCH",
        body: JSON.stringify({ usdToClp: fx, whatsappRates: rates }),
      });
      await load();
      setStatus({ kind: "ok", text: "Tarifas y tipo de cambio guardados ✔" });
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="display" style={sectionTitle}>Tarifas y modelo de costos</h2>
      <p className="text-dim" style={sectionHint}>
        Tarifas vigentes: IA por token (lista de modelos) y WhatsApp por mensaje según país.
        El tipo de cambio y las tarifas de Meta por país se guardan y afectan la facturación real.
      </p>

      {loadError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{loadError}</p> : !cost ? (
        <p className="text-dim" style={{ fontSize: 13 }}>Cargando…</p>
      ) : (
        <>
          {/* Modelo de IA (solo lectura) */}
          <h3 style={{ fontSize: 13, color: "var(--ink-dim)", margin: "4px 0 8px", fontWeight: 600 }}>
            Modelo de IA — costo por millón de tokens (solo lectura)
          </h3>
          <div style={{ overflowX: "auto", marginBottom: 20 }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--ink-dim)" }}>
                  <th style={{ padding: "6px 8px 6px 0" }}>Modelo</th>
                  <th style={{ padding: "6px 8px" }}>Entrada (US$/MTok)</th>
                  <th style={{ padding: "6px 8px" }}>Salida (US$/MTok)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(cost.models).map(([name, p]) => (
                  <tr key={name} style={{ borderTop: "1px solid var(--hairline)" }}>
                    <td style={{ padding: "6px 8px 6px 0", fontFamily: "monospace", color: "var(--ink)" }}>{name}</td>
                    <td style={{ padding: "6px 8px", color: "var(--ink-dim)" }}>US${p.inputPerMTok}</td>
                    <td style={{ padding: "6px 8px", color: "var(--ink-dim)" }}>US${p.outputPerMTok}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tipo de cambio */}
          <label style={{ ...labelStyle, marginBottom: 18 }}>
            Tipo de cambio USD → CLP
            <input
              type="number"
              min={0}
              value={fx}
              onChange={(e) => setFx(Number(e.target.value))}
              style={numField}
            />
          </label>

          {/* Tarifas de WhatsApp por país (editable) */}
          <h3 style={{ fontSize: 13, color: "var(--ink-dim)", margin: "4px 0 8px", fontWeight: 600 }}>
            Tarifas de WhatsApp por mensaje (US$) — «default» = fallback · servicio dentro de 24 h = gratis
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--ink-dim)" }}>
                  <th style={{ padding: "6px 8px 6px 0" }}>País</th>
                  <th style={{ padding: "6px 8px" }}>Marketing</th>
                  <th style={{ padding: "6px 8px" }}>Utilidad</th>
                  <th style={{ padding: "6px 8px" }}>Autenticación</th>
                  <th style={{ padding: "6px 8px" }}>Servicio</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(rates).sort().map((cc) => (
                  <tr key={cc} style={{ borderTop: "1px solid var(--hairline)" }}>
                    <td style={{ padding: "6px 8px 6px 0", fontFamily: "monospace", fontWeight: 600, color: "var(--ink)" }}>{cc}</td>
                    {(["marketing", "utility", "authentication", "service"] as const).map((k) => (
                      <td key={k} style={{ padding: "6px 8px" }}>
                        <input
                          type="number"
                          step="0.001"
                          min={0}
                          value={rates[cc][k]}
                          onChange={(e) => setRate(cc, k, Number(e.target.value))}
                          style={{
                            width: 100,
                            padding: "6px 8px",
                            borderRadius: 8,
                            border: "1px solid var(--line)",
                            background: "var(--surface-solid)",
                            color: "var(--ink)",
                            fontSize: 13,
                            textAlign: "right",
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 14 }}>
            <input
              value={newCountry}
              onChange={(e) => setNewCountry(e.target.value)}
              placeholder="Agregar país (ISO, ej: BR)"
              maxLength={3}
              style={{ ...field, width: 200, marginTop: 0, textTransform: "uppercase" }}
            />
            <button
              type="button"
              onClick={addCountry}
              className="text-dim"
              style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 10, padding: "9px 14px", fontSize: 13 }}
            >
              Agregar país
            </button>
          </div>

          <button
            className="btn-accent"
            type="button"
            onClick={() => void save()}
            disabled={busy}
            style={{ marginTop: 16, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Guardando…" : "Guardar tarifas y tipo de cambio"}
          </button>
          <StatusLine status={status} />
        </>
      )}
    </section>
  );
}

// =========================================================================
// 2) Límites de mensajería — GET + PATCH /messaging-limits
// =========================================================================
function MessagingLimitsSection() {
  const [data, setData] = useState<Limits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [global, setGlobal] = useState(0);
  const [perTenant, setPerTenant] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const load = () =>
    padmin<Limits>("/platform/messaging-limits")
      .then((d) => {
        setData(d);
        setGlobal(d.global);
        setPerTenant(d.perTenantDefault);
      })
      .catch((e) => setLoadError(errMsg(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      await padmin("/platform/messaging-limits", {
        method: "PATCH",
        body: JSON.stringify({ global, perTenantDefault: perTenant }),
      });
      await load();
      setStatus({ kind: "ok", text: "Límites actualizados ✔" });
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const rate = data?.clpPerMsg;
  const clpHint = (n: number) =>
    rate && n > 0 ? (
      <p className="text-dim" style={{ margin: "6px 0 0", fontSize: 12 }}>
        ≈ {clp(n * rate.utility)}/día si todo es utilidad · hasta {clp(n * rate.marketing)}/día si todo es marketing
      </p>
    ) : null;

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="display" style={sectionTitle}>Límites de mensajería</h2>
      <p className="text-dim" style={sectionHint}>
        Fusible global y tope por defecto por tenant. Solo afectan mensajes de plantilla (los que cuestan);
        las respuestas dentro de 24 h nunca se tocan.
      </p>

      {loadError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{loadError}</p> : !data ? (
        <p className="text-dim" style={{ fontSize: 13 }}>Cargando…</p>
      ) : (
        <>
          {/* Estado del fusible + consumo del día */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: 14,
              borderRadius: 12,
              border: `1px solid ${data.fuseTripped ? "var(--danger)" : "var(--line)"}`,
              background: "var(--surface-solid)",
              marginBottom: 18,
            }}
          >
            <span style={{ fontSize: 20 }}>{data.fuseTripped ? "🛑" : "📊"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                Consumo global de hoy: {data.todayGlobal.toLocaleString("es-CL")} / {data.global.toLocaleString("es-CL")} plantillas
              </p>
              <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                {data.fuseTripped
                  ? "⚠ Fusible CORTADO: los envíos de plantilla están en pausa para todos. Sube el tope global y se reanudan."
                  : rate
                    ? `Equivale hoy a ~${clp(data.todayGlobal * rate.utility)}–${clp(data.todayGlobal * rate.marketing)} CLP.`
                    : ""}
              </p>
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: data.fuseTripped ? "var(--danger)" : "var(--ok)" }}>
              {data.fuseTripped ? "Cortado" : "Normal"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <label style={labelStyle}>Fusible global (plantillas/día, toda la plataforma)</label>
              <p className="text-dim" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Al superarlo se cortan los envíos de plantilla de todos los tenants y te llega alerta. Red contra un bug o abuso masivo.
              </p>
              <input type="number" min={1} value={global} onChange={(e) => setGlobal(Number(e.target.value))} style={numField} />
              {clpHint(global)}
            </div>
            <div>
              <label style={labelStyle}>Tope por defecto por tenant (plantillas/día)</label>
              <p className="text-dim" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Se aplica a cada tenant que no tenga un tope propio (ese se fija en la ficha de cada organización).
              </p>
              <input type="number" min={1} value={perTenant} onChange={(e) => setPerTenant(Number(e.target.value))} style={numField} />
              {clpHint(perTenant)}
            </div>
          </div>

          <button
            className="btn-accent"
            type="button"
            onClick={() => void save()}
            disabled={busy || global < 1 || perTenant < 1}
            style={{ marginTop: 16, opacity: busy || global < 1 || perTenant < 1 ? 0.6 : 1 }}
          >
            {busy ? "Guardando…" : "Guardar límites"}
          </button>
          <StatusLine status={status} />
        </>
      )}
    </section>
  );
}

// =========================================================================
// 3) Pesos de la bolsa — GET + PATCH /wallet-weights
// =========================================================================
function WalletWeightsSection() {
  const [weights, setWeights] = useState<Weights | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    padmin<Weights>("/platform/wallet-weights")
      .then(setWeights)
      .catch((e) => setLoadError(errMsg(e)));
  }, []);

  async function save() {
    if (!weights) return;
    setBusy(true);
    setStatus(null);
    try {
      await padmin("/platform/wallet-weights", { method: "PATCH", body: JSON.stringify(weights) });
      setStatus({ kind: "ok", text: "Pesos guardados ✔" });
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const keyLabel: Record<keyof Weights, string> = { utility: "Utilidad", authentication: "Autenticación", marketing: "Marketing" };

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="display" style={sectionTitle}>Pesos de la bolsa</h2>
      <p className="text-dim" style={sectionHint}>
        Cuántos créditos descuenta cada mensaje de la bolsa prepagada. <b>1/1/1</b> = por cantidad (modo A).
        Sube <b>marketing</b> (p. ej. 4) para proteger margen (modo B), ya que marketing cuesta ~4× una utilidad.
        Conversia usa 1/1/1/4.
      </p>

      {loadError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{loadError}</p> : !weights ? (
        <p className="text-dim" style={{ fontSize: 13 }}>Cargando…</p>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
            {(["utility", "authentication", "marketing"] as const).map((k) => (
              <label key={k} style={labelStyle}>
                {keyLabel[k]}
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={weights[k]}
                  onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                  style={{ ...numField, width: 110 }}
                />
              </label>
            ))}
          </div>
          <button
            className="btn-accent"
            type="button"
            onClick={() => void save()}
            disabled={busy}
            style={{ marginTop: 16, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Guardando…" : "Guardar pesos"}
          </button>
          <StatusLine status={status} />
        </>
      )}
    </section>
  );
}

// =========================================================================
// 4) Precio de activación de plantillas — GET + PATCH /templates-pricing
// =========================================================================
function TemplatesPricingSection() {
  const [pricing, setPricing] = useState<TemplatesPricing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    // Si el GET no existiera, caemos a un form vacío (set-only) sin romper la sección.
    padmin<TemplatesPricing>("/platform/templates-pricing")
      .then(setPricing)
      .catch((e) => {
        if (e instanceof PlatformApiError && e.status === 404) {
          setPricing({ priceClp: null, priceUsd: null });
        } else {
          setLoadError(errMsg(e));
        }
      });
  }, []);

  async function save() {
    if (!pricing) return;
    setBusy(true);
    setStatus(null);
    try {
      await padmin("/platform/templates-pricing", { method: "PATCH", body: JSON.stringify(pricing) });
      setStatus({ kind: "ok", text: "Precio de activación guardado ✔" });
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ padding: 20 }}>
      <h2 className="display" style={sectionTitle}>Precio de activación de plantillas</h2>
      <p className="text-dim" style={sectionHint}>
        Precio de referencia para cobrar la activación de la capacidad de plantillas por cliente (servicio adicional).
        Se muestra en el panel del cliente cuando la función no está incluida. Déjalo vacío si va incluida en el plan.
      </p>

      {loadError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{loadError}</p> : !pricing ? (
        <p className="text-dim" style={{ fontSize: 13 }}>Cargando…</p>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
            <label style={labelStyle}>
              Precio CLP
              <input
                type="number"
                min={0}
                value={pricing.priceClp ?? ""}
                onChange={(e) => setPricing((p) => ({ ...(p as TemplatesPricing), priceClp: e.target.value === "" ? null : Number(e.target.value) }))}
                style={{ ...numField, width: 140 }}
              />
            </label>
            <label style={labelStyle}>
              Precio USD
              <input
                type="number"
                min={0}
                step="0.01"
                value={pricing.priceUsd ?? ""}
                onChange={(e) => setPricing((p) => ({ ...(p as TemplatesPricing), priceUsd: e.target.value === "" ? null : Number(e.target.value) }))}
                style={{ ...numField, width: 140 }}
              />
            </label>
          </div>
          <button
            className="btn-accent"
            type="button"
            onClick={() => void save()}
            disabled={busy}
            style={{ marginTop: 16, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Guardando…" : "Guardar precio"}
          </button>
          <StatusLine status={status} />
        </>
      )}
    </section>
  );
}
