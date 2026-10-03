"use client";
/**
 * Facturación (consola super admin de Conversia) — página COMBINADA que reúne lo que en
 * TuBot vivía en tres rutas: pasarelas de pago, cobro recurrente (MRR), facturas y margen
 * por cliente. Habla con la MISMA API de plataforma vía padmin (el backend acota por marca
 * según el Origin/brand del token). Cada sección carga y falla por separado para que un
 * endpoint caído no tumbe el resto.
 */
import { useCallback, useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

// ----------------------------- Tipos de respuesta -----------------------------

interface Providers {
  flow: { label: string; configured: boolean; source: string | null; baseUrl: string; webhookUrl: string };
  lemonSqueezy: { label: string; configured: boolean; source: string | null; storeId: string | null; hasWebhookSecret: boolean; webhookUrl: string };
  resend: { label: string; configured: boolean; source: string | null; envVars: string[] };
}
interface Recurring {
  mrr: number;
  counts: { active: number; pastDue: number; suspended: number; canceling: number; failed30: number };
  upcoming: Array<{ org: string; nextChargeAt: string | null; interval: string }>;
}
interface Invoice {
  id: string;
  number: string;
  organizationId: string;
  organizationName: string;
  status: string;
  currency: string;
  amountDue: string | number;
  createdAt: string;
  dueAt: string | null;
}
interface MarginRow {
  id: string;
  name: string;
  revenueClp: number;
  metaCostClp: number;
  aiCostClp: number;
  marginClp: number;
  marginPct: number | null;
}
interface Margins {
  month: string;
  rows: MarginRow[];
}

// ------------------------------- Utilidades UI --------------------------------

const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;
const msg = (e: unknown) => (e instanceof PlatformApiError ? e.message : (e as Error).message);

const INVOICE_STATUS_COLOR: Record<string, string> = {
  PAID: "var(--ok)",
  OPEN: "var(--warn)",
  DRAFT: "var(--ink-dim)",
  VOID: "var(--ink-dim)",
  UNCOLLECTIBLE: "var(--danger)",
};

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--surface-solid)",
  color: "var(--ink)",
  fontSize: 14,
};
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--ink-dim)", borderBottom: "1px solid var(--line)" };
const td: React.CSSProperties = { padding: "9px 10px", fontSize: 13, borderBottom: "1px solid var(--hairline)" };

function Badge({ configured, source }: { configured: boolean; source: string | null }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: configured ? "var(--ok)" : "var(--warn)" }}>
      {configured ? `● configurado${source ? ` · ${source}` : ""}` : "○ falta configurar"}
    </span>
  );
}

// =============================================================================

export default function AdminBilling() {
  // Cada sección con su propio estado de carga/error (data=null → cargando).
  const [providers, setProviders] = useState<Providers | null>(null);
  const [provError, setProvError] = useState<string | null>(null);
  const [recurring, setRecurring] = useState<Recurring | null>(null);
  const [recError, setRecError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [invError, setInvError] = useState<string | null>(null);
  const [margins, setMargins] = useState<Margins | null>(null);
  const [marError, setMarError] = useState<string | null>(null);

  // Formularios de credenciales (SOLO escritura: vacío = no cambiar, nunca mostramos secretos).
  const [flowForm, setFlowForm] = useState({ apiKey: "", secretKey: "", baseUrl: "" });
  const [lsForm, setLsForm] = useState({ apiKey: "", storeId: "", webhookSecret: "" });
  const [saving, setSaving] = useState<"flow" | "lemonsqueezy" | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [flowTest, setFlowTest] = useState<{ ok: boolean; detail: string } | null>(null);

  const loadProviders = useCallback(() => {
    setProvError(null);
    return padmin<Providers>("/platform/billing/providers").then(setProviders).catch((e) => setProvError(msg(e)));
  }, []);
  const loadInvoices = useCallback(() => {
    setInvError(null);
    return padmin<Invoice[]>("/platform/invoices").then(setInvoices).catch((e) => setInvError(msg(e)));
  }, []);

  useEffect(() => {
    void loadProviders();
    void loadInvoices();
    padmin<Recurring>("/platform/billing/recurring").then(setRecurring).catch((e) => setRecError(msg(e)));
    padmin<Margins>("/platform/margins").then(setMargins).catch((e) => setMarError(msg(e)));
  }, [loadProviders, loadInvoices]);

  async function saveProvider(provider: "flow" | "lemonsqueezy") {
    setSaving(provider);
    setSavedNote(null);
    try {
      const payload =
        provider === "flow"
          ? { provider, flow: { apiKey: flowForm.apiKey || undefined, secretKey: flowForm.secretKey || undefined, baseUrl: flowForm.baseUrl || undefined } }
          : { provider, lemonsqueezy: { apiKey: lsForm.apiKey || undefined, storeId: lsForm.storeId || undefined, webhookSecret: lsForm.webhookSecret || undefined } };
      await padmin("/platform/billing/settings", { method: "POST", body: JSON.stringify(payload) });
      setSavedNote(provider === "flow" ? "Credenciales de Flow guardadas ✔" : "Credenciales de Lemon Squeezy guardadas ✔");
      if (provider === "flow") setFlowForm({ apiKey: "", secretKey: "", baseUrl: "" });
      else setLsForm({ apiKey: "", storeId: "", webhookSecret: "" });
      await loadProviders();
    } catch (e) {
      setProvError(msg(e));
    } finally {
      setSaving(null);
    }
  }

  async function testFlow() {
    setTesting(true);
    setFlowTest(null);
    try {
      setFlowTest(await padmin<{ ok: boolean; detail: string }>("/platform/billing/flow/test", { method: "POST" }));
    } catch (e) {
      setFlowTest({ ok: false, detail: msg(e) });
    } finally {
      setTesting(false);
    }
  }

  async function markPaid(inv: Invoice) {
    if (!confirm(`¿Marcar la factura ${inv.number} como PAGADA? Esta acción queda auditada.`)) return;
    try {
      await padmin(`/platform/invoices/${inv.id}/mark-paid`, { method: "POST" });
      await loadInvoices();
    } catch (e) {
      setInvError(msg(e));
    }
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Facturación</h1>
      <p className="text-dim" style={{ margin: "0 0 22px", fontSize: 14 }}>
        Pasarelas de pago, cobro recurrente, facturas emitidas y el margen que deja cada cliente. Todo acotado a tu marca.
      </p>

      {/* ----------------------- 1. Pasarelas de pago ----------------------- */}
      <section style={{ marginBottom: 24 }}>
        <h2 className="display" style={{ fontSize: 18, margin: "0 0 10px" }}>Pasarelas de pago</h2>
        {provError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{provError}</p> : null}
        {savedNote ? <p style={{ color: "var(--ok)", fontSize: 13, margin: "0 0 10px" }}>{savedNote}</p> : null}
        {!providers ? (
          <p className="text-dim">Cargando…</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
            {/* Flow */}
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{providers.flow.label}</h3>
                <Badge configured={providers.flow.configured} source={providers.flow.source} />
              </div>
              <p className="text-dim" style={{ fontSize: 12, margin: "0 0 12px" }}>
                Pega tus credenciales de Flow. Se guardan cifradas y no se muestran de vuelta; deja un campo vacío para no cambiarlo.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input style={field} type="password" autoComplete="off" placeholder="API Key" value={flowForm.apiKey} onChange={(e) => setFlowForm({ ...flowForm, apiKey: e.target.value })} />
                <input style={field} type="password" autoComplete="off" placeholder="Secret Key" value={flowForm.secretKey} onChange={(e) => setFlowForm({ ...flowForm, secretKey: e.target.value })} />
                <input style={field} placeholder={`Base URL (actual: ${providers.flow.baseUrl})`} value={flowForm.baseUrl} onChange={(e) => setFlowForm({ ...flowForm, baseUrl: e.target.value })} />
                <p className="text-dim" style={{ fontSize: 11, margin: 0 }}>Producción: https://www.flow.cl/api · Sandbox: https://sandbox.flow.cl/api</p>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                <button className="btn-accent" disabled={saving === "flow"} onClick={() => void saveProvider("flow")} style={{ opacity: saving === "flow" ? 0.6 : 1 }}>
                  {saving === "flow" ? "Guardando…" : "Guardar Flow"}
                </button>
                <button
                  onClick={() => void testFlow()}
                  disabled={testing || !providers.flow.configured}
                  className="text-dim"
                  style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: testing || !providers.flow.configured ? "default" : "pointer", borderRadius: 10, padding: "8px 14px", fontSize: 13, opacity: testing || !providers.flow.configured ? 0.5 : 1 }}
                >
                  {testing ? "Probando…" : "Probar credenciales"}
                </button>
              </div>
              {flowTest ? (
                <p style={{ marginTop: 10, fontSize: 12, color: flowTest.ok ? "var(--ok)" : "var(--danger)" }}>
                  {flowTest.ok ? "✓" : "✖"} {flowTest.detail}
                </p>
              ) : null}
            </div>

            {/* Lemon Squeezy */}
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{providers.lemonSqueezy.label}</h3>
                <Badge configured={providers.lemonSqueezy.configured} source={providers.lemonSqueezy.source} />
              </div>
              <p className="text-dim" style={{ fontSize: 12, margin: "0 0 12px" }}>
                Para cobros en USD / internacional. {providers.lemonSqueezy.storeId ? `Store actual: ${providers.lemonSqueezy.storeId}.` : ""} Deja un campo vacío para no cambiarlo.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input style={field} type="password" autoComplete="off" placeholder="API Key" value={lsForm.apiKey} onChange={(e) => setLsForm({ ...lsForm, apiKey: e.target.value })} />
                <input style={field} placeholder="Store ID" value={lsForm.storeId} onChange={(e) => setLsForm({ ...lsForm, storeId: e.target.value })} />
                <input style={field} type="password" autoComplete="off" placeholder="Webhook Signing Secret" value={lsForm.webhookSecret} onChange={(e) => setLsForm({ ...lsForm, webhookSecret: e.target.value })} />
              </div>
              <p className="text-dim" style={{ fontSize: 11, margin: "10px 0 4px" }}>URL de webhook (pégala en Lemon Squeezy → Settings → Webhooks, con el mismo Signing Secret):</p>
              <code style={{ display: "block", padding: "7px 10px", borderRadius: 8, background: "var(--surface-solid)", border: "1px solid var(--line)", fontSize: 11, wordBreak: "break-all", color: "var(--ink-dim)" }}>{providers.lemonSqueezy.webhookUrl}</code>
              <button className="btn-accent" disabled={saving === "lemonsqueezy"} onClick={() => void saveProvider("lemonsqueezy")} style={{ marginTop: 14, opacity: saving === "lemonsqueezy" ? 0.6 : 1 }}>
                {saving === "lemonsqueezy" ? "Guardando…" : "Guardar Lemon Squeezy"}
              </button>
            </div>

            {/* Resend (correos) — solo estado, se configura por env. */}
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{providers.resend.label}</h3>
                <Badge configured={providers.resend.configured} source={providers.resend.source} />
              </div>
              <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>
                Envío de correos (facturas, avisos). Se configura por variables de entorno: {providers.resend.envVars.join(", ")}.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* -------------------- 2. Cobro recurrente (MRR) -------------------- */}
      <section style={{ marginBottom: 24 }}>
        <h2 className="display" style={{ fontSize: 18, margin: "0 0 10px" }}>Cobro recurrente (MRR)</h2>
        {recError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{recError}</p> : null}
        {!recurring ? (
          <p className="text-dim">Cargando…</p>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
              {[
                { label: "MRR (ingreso recurrente mensual)", value: clp(recurring.mrr), color: "var(--ok)" },
                { label: "Suscripciones activas", value: recurring.counts.active, color: "var(--ink)" },
                { label: "Pago pendiente (en gracia)", value: recurring.counts.pastDue, color: recurring.counts.pastDue ? "var(--warn)" : "var(--ink)" },
                { label: "Suspendidas por impago", value: recurring.counts.suspended, color: recurring.counts.suspended ? "var(--danger)" : "var(--ink)" },
                { label: "Por cancelar (fin de período)", value: recurring.counts.canceling, color: "var(--ink)" },
                { label: "Cobros fallidos (30 días)", value: recurring.counts.failed30, color: recurring.counts.failed30 ? "var(--warn)" : "var(--ink)" },
              ].map((c) => (
                <div key={c.label} className="card" style={{ padding: 16 }}>
                  <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>{c.label}</p>
                  <p style={{ margin: "6px 0 0", fontSize: 24, fontWeight: 700, color: c.color }}>{c.value}</p>
                </div>
              ))}
            </div>
            <div className="card" style={{ padding: 18, marginTop: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>Próximos cobros (7 días)</p>
              {recurring.upcoming.length === 0 ? (
                <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Sin cobros programados en los próximos 7 días.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {recurring.upcoming.map((u, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < recurring.upcoming.length - 1 ? "1px solid var(--hairline)" : "none", fontSize: 13 }}>
                      <span>{u.org}</span>
                      <span className="text-dim">
                        {u.nextChargeAt ? new Date(u.nextChargeAt).toLocaleDateString("es-CL") : "—"} · {u.interval === "yearly" ? "anual" : "mensual"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {/* --------------------------- 3. Facturas --------------------------- */}
      <section style={{ marginBottom: 24 }}>
        <h2 className="display" style={{ fontSize: 18, margin: "0 0 10px" }}>Facturas</h2>
        {invError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{invError}</p> : null}
        {!invoices ? (
          <p className="text-dim">Cargando…</p>
        ) : invoices.length === 0 ? (
          <div className="card" style={{ padding: 22 }}>
            <p style={{ margin: 0 }}>Aún no hay facturas emitidas.</p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={th}>Número</th>
                  <th style={th}>Cliente</th>
                  <th style={{ ...th, textAlign: "right" }}>Monto</th>
                  <th style={th}>Estado</th>
                  <th style={th}>Fecha</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{inv.number}</td>
                    <td style={td}>{inv.organizationName}</td>
                    <td style={{ ...td, textAlign: "right" }}>{inv.currency} {Number(inv.amountDue).toLocaleString("es-CL")}</td>
                    <td style={td}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: INVOICE_STATUS_COLOR[inv.status] ?? "var(--ink-dim)" }}>● {inv.status}</span>
                    </td>
                    <td style={{ ...td, color: "var(--ink-dim)", fontSize: 12 }}>{new Date(inv.createdAt).toLocaleDateString("es-CL")}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {inv.status !== "PAID" ? (
                        <button
                          onClick={() => void markPaid(inv)}
                          className="text-dim"
                          style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12 }}
                        >
                          Marcar pagada
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ----------------------- 4. Margen por cliente --------------------- */}
      <section style={{ marginBottom: 12 }}>
        <h2 className="display" style={{ fontSize: 18, margin: "0 0 4px" }}>Margen por cliente</h2>
        <p className="text-dim" style={{ fontSize: 13, margin: "0 0 10px" }}>
          Ingreso cobrado del mes menos el costo real de Meta (mensajería) e IA, por tenant. Los que pierden plata aparecen primero.
        </p>
        {marError ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{marError}</p> : null}
        {!margins ? (
          <p className="text-dim">Cargando…</p>
        ) : margins.rows.length === 0 ? (
          <div className="card" style={{ padding: 22 }}>
            <p style={{ margin: 0 }}>Sin datos de margen este mes.</p>
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={th}>Tenant</th>
                    <th style={{ ...th, textAlign: "right" }}>Ingreso</th>
                    <th style={{ ...th, textAlign: "right" }}>Costo Meta</th>
                    <th style={{ ...th, textAlign: "right" }}>Costo IA</th>
                    <th style={{ ...th, textAlign: "right" }}>Margen</th>
                    <th style={{ ...th, textAlign: "right" }}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {margins.rows.map((r) => {
                    const neg = r.marginClp < 0;
                    return (
                      <tr key={r.id} style={neg ? { background: "color-mix(in srgb, var(--danger) 10%, transparent)" } : undefined}>
                        <td style={{ ...td, fontWeight: 600 }}>{neg ? "▼ " : ""}{r.name}</td>
                        <td style={{ ...td, textAlign: "right" }}>{clp(r.revenueClp)}</td>
                        <td style={{ ...td, textAlign: "right", color: "var(--ink-dim)" }}>{clp(r.metaCostClp)}</td>
                        <td style={{ ...td, textAlign: "right", color: "var(--ink-dim)" }}>{clp(r.aiCostClp)}</td>
                        <td style={{ ...td, textAlign: "right", fontWeight: 600, color: neg ? "var(--danger)" : "var(--ok)" }}>{clp(r.marginClp)}</td>
                        <td style={{ ...td, textAlign: "right", color: neg ? "var(--danger)" : "var(--ink-dim)" }}>{r.marginPct === null ? "—" : `${r.marginPct}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
              Mes {margins.month}. Costos convertidos a CLP con el tipo de cambio del Super Admin. Un margen negativo = ese cliente cuesta más de lo que paga.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
