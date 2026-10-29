"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { leerRetorno, type Retorno } from "@/lib/cobros-retorno";

/**
 * COBROS — la pantalla de dinero del cliente de Conversia (su plan, sus créditos y su
 * método de pago). Es también la pantalla de RETORNO de la pasarela: la API manda los
 * `successUrl`/`cancelUrl`/`urlReturn` de una org Conversia a `/cobros` (antes iban al
 * `/billing` de TuBot, que acá no existe → el cliente terminaba en un 404 después de
 * pagar). Lee:
 *   - `?pago=ok`        → volvió de pagar (lo confirma el webhook de la pasarela).
 *   - `?pago=cancelado` → abandonó el pago; no se le cobró nada.
 *   - `?card=1`         → volvió de registrar la tarjeta en Flow → confirma con la API.
 *
 * Flujo de tarjeta (mismo contrato que TuBot, apps/web/.../subscription-self-service.tsx):
 *   POST /billing/subscription/start {planCode, billingInterval} → {url, token}
 *   → guardamos el token en sessionStorage y vamos a la página segura de Flow
 *   → Flow devuelve a /cobros?card=1
 *   → POST /billing/subscription/confirm-card {token} → {registered}
 * Nunca pasan datos de tarjeta por acá: solo el token de la operación.
 */

// Estado de suscripción en español (es-CL), sin anglicismos técnicos. La API devuelve el
// estado en MAYÚSCULAS (TRIALING/ACTIVE/PAST_DUE/…) → se busca en minúsculas.
const SUB_ESTADO: Record<string, string> = {
  active: "activa",
  trialing: "en prueba",
  past_due: "pago pendiente",
  paused: "en pausa",
  suspended: "suspendida",
  canceled: "cancelada",
  cancelled: "cancelada",
  incomplete: "incompleta",
  unpaid: "impaga",
};
const subEstado = (s: string) => SUB_ESTADO[s.toLowerCase()] ?? s;

type MetaCostos = { mensajes: number; usd: number; clpAprox: number; clpPorUsd: number; porCategoria: Record<string, { mensajes: number; usd: number }>; desde: string };
type Medidor = { conversaciones: number; dias: number | null; creditosPorConversacion: number; base: "org" | "rubro" | "defecto"; frase: string; explicacion: string };
type Summary = { unit?: string; balance: number; included: number; consumed: number; byCategory: Record<string, number>; projected: number; pctUsed: number; over80: boolean; medidor?: Medidor };
type Me = {
  organization: { currency: string };
  plan: { code: string; name: string; interval: string } | null;
  subscription: { status: string; periodEnd: string | null; interval: string } | null;
  paymentMethod: { provider: string; brand: string | null; last4: string | null } | null;
  /** Pasarela con la que pagaría hoy esta cuenta ("flow" en Chile). */
  paymentProvider: string;
};
type Pkg = { code: string; name: string; credits: number; priceClp: number; priceUsd: number; bonoPct?: number };
type Plan = { code: string; name: string; priceClp: number; priceUsd: number; priceClpYearly: number | null; priceUsdYearly: number | null; custom: boolean };

const CAT_LABEL: Record<string, string> = { utility: "Utilidad", authentication: "Autenticación", marketing: "Marketing", service: "Servicio", otro: "Otro" };

/** Token de la operación de registro de tarjeta mientras el cliente está en Flow. */
const CARD_TOKEN_KEY = "conversia_card_token";
function ssGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null; // modo privado / almacenamiento bloqueado
  }
}
function ssSet(k: string, v: string): void {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* noop */
  }
}
function ssDel(k: string): void {
  try {
    sessionStorage.removeItem(k);
  } catch {
    /* noop */
  }
}

function barColor(pct: number): string {
  if (pct >= 100) return "var(--danger)";
  if (pct >= 80) return "var(--warn)";
  return "var(--ok)";
}

/** Aviso único de la pantalla (retorno de la pasarela, tarjeta, errores). */
type Aviso = { kind: "ok" | "info" | "warn" | "error"; text: string };
const AVISO_COLOR: Record<Aviso["kind"], string> = { ok: "var(--ok)", info: "var(--acc-deep)", warn: "var(--warn)", error: "var(--danger)" };

/**
 * El retorno de la pasarela se captura al CARGAR EL MÓDULO, no dentro de un efecto.
 *
 * Por qué: la pasarela devuelve al cliente con una navegación COMPLETA
 * (`/cobros?pago=ok`), y leer la URL recién en un efecto es frágil — si algo la limpia
 * antes, o si el subárbol se vuelve a montar después de que ya la limpiamos nosotros, el
 * aviso se pierde y el cliente queda mirando una pantalla que no le dice si pagó o no.
 * Eso es justamente lo que detectó la jornada G en CI: la región de estado quedaba vacía.
 * Al capturarlo acá queda fijado antes de que corra cualquier efecto.
 *
 * Solo aplica a navegaciones completas (que es como vuelve la pasarela); si alguien llega
 * a /cobros navegando dentro de la app, no hay retorno que leer.
 */
const RETORNO_AL_CARGAR: Retorno = typeof window === "undefined" ? null : leerRetorno(window.location.search);

export default function Cobros() {
  const [me, setMe] = useState<Me | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [interval, setIntervalSel] = useState<"monthly" | "yearly">("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);

  const load = useCallback(async () => {
    const m = await api<Me>("/billing/me").catch((e) => {
      setError((e as Error).message);
      return null;
    });
    if (m) setMe(m);
    await Promise.all([
      api<Summary>("/billing/wallet/summary").then(setS).catch(() => {}),
      api<{ packages: Pkg[] }>("/billing/wallet").then((r) => setPkgs(r.packages)).catch(() => {}),
      api<Plan[]>("/billing/plans").then(setPlans).catch(() => {}),
    ]);
  }, []);

  // ───────────── Retorno de la pasarela (una sola vez por carga) ─────────────
  const retornoLeido = useRef(false);
  useEffect(() => {
    void load();
    if (retornoLeido.current) return;
    retornoLeido.current = true;
    const retorno = RETORNO_AL_CARGAR;
    if (!retorno) return;
    // Limpia la URL para que un refresco no repita el aviso ni la confirmación.
    window.history.replaceState(null, "", window.location.pathname);
    if (retorno === "tarjeta") {
      void confirmarTarjeta();
    } else if (retorno === "pago-ok") {
      setAviso({
        kind: "ok",
        text: "Pago recibido. Lo estamos confirmando con la pasarela: tu plan y tus créditos quedan activos en cuanto nos lo confirme (suele ser cuestión de segundos).",
      });
    } else {
      setAviso({ kind: "warn", text: "Cancelaste el pago, así que no te cobramos nada. Puedes volver a intentarlo cuando quieras." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const currency = me?.organization.currency ?? "CLP";
  const money = (clpV: number, usdV: number) =>
    currency === "CLP" ? "$" + Math.round(clpV).toLocaleString("es-CL") : "US$" + Math.round(usdV).toLocaleString("en-US");

  /** Plan de pago vigente (el de prueba/gratis no está en el catálogo → no sirve para la tarjeta). */
  const planContratado = me?.plan && plans.some((p) => p.code === me.plan!.code && !p.custom) ? me.plan.code : null;
  const conFlow = me?.paymentProvider === "flow" || !!me?.paymentMethod;
  /** Hay una operación de tarjeta en vuelo (abriendo Flow o confirmando el retorno). */
  const tarjetaEnCurso = busy === "card" || !!busy?.startsWith("card:");

  // ───────────── Registro de tarjeta (Flow) ─────────────

  async function confirmarTarjeta() {
    const token = ssGet(CARD_TOKEN_KEY);
    if (!token) {
      setAviso({
        kind: "warn",
        text: "Volviste del registro de tarjeta, pero no pudimos retomar la operación en este navegador. Si tu tarjeta quedó registrada la verás más abajo; si no, vuelve a intentarlo.",
      });
      return;
    }
    setBusy("card");
    setAviso({ kind: "info", text: "Estamos confirmando tu tarjeta…" });
    try {
      const r = await api<{ registered: boolean }>("/billing/subscription/confirm-card", { method: "POST", body: JSON.stringify({ token }) });
      ssDel(CARD_TOKEN_KEY);
      setAviso(
        r.registered
          ? {
              kind: "ok",
              text: "Tarjeta registrada ✔ Estamos procesando el primer cobro de tu plan. Se renovará solo en cada fecha y puedes cambiar la tarjeta cuando quieras.",
            }
          : { kind: "error", text: "No pudimos registrar tu tarjeta y no te cobramos nada. Revisa los datos o prueba con otra tarjeta." },
      );
      await load();
    } catch (e) {
      setAviso({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Activa el cobro automático: registra la tarjeta en la página segura de Flow (el token
   * de la operación queda en sessionStorage para confirmarlo al volver). Si la cuenta de
   * Flow todavía no tiene cobro automático —o no hay Flow configurado— no dejamos al
   * cliente sin poder pagar: cae al checkout de pago único.
   */
  async function registrarTarjeta(planCode: string) {
    setBusy("card:" + planCode);
    setError(null);
    try {
      const r = await api<{ url: string; token: string }>("/billing/subscription/start", {
        method: "POST",
        body: JSON.stringify({ planCode, billingInterval: interval }),
      });
      ssSet(CARD_TOKEN_KEY, r.token);
      setAviso({ kind: "info", text: "Te llevamos a la página segura de Flow para registrar tu tarjeta…" });
      window.location.href = r.url;
    } catch (e) {
      const m = (e as Error).message;
      if (/FLOW_NO_AUTO_CHARGE|Flow no est[áa] configurado/i.test(m)) {
        setAviso({ kind: "info", text: "El cobro automático todavía no está disponible: lo procesamos como un pago único." });
        await checkout(planCode);
        return;
      }
      setAviso({ kind: "error", text: m });
      setBusy(null);
    }
  }

  // ───────────── Checkout (pago único / mock en desarrollo) ─────────────

  async function checkout(planCode: string) {
    setBusy("plan:" + planCode);
    try {
      const r = await api<{ url?: string; mock?: boolean }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planCode, billingInterval: interval }),
      });
      if (r.mock) {
        // Sin pasarela real (desarrollo): se confirma simulado, SIN cobro.
        await api("/billing/mock-confirm", { method: "POST", body: JSON.stringify({ planCode, billingInterval: interval }) });
        setAviso({ kind: "ok", text: "Pago de PRUEBA confirmado (no hubo cobro real). Tu plan quedó activo." });
        await load();
      } else if (r.url) {
        window.location.href = r.url;
      } else {
        setAviso({ kind: "error", text: "No pudimos abrir el pago. Inténtalo de nuevo en un momento." });
      }
    } catch (e) {
      setAviso({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  /** Puerta única de pago del plan: con Flow va por tarjeta (recurrente); si no, checkout. */
  function contratar(planCode: string) {
    setAviso(null);
    if (me?.paymentProvider === "flow") return void registrarTarjeta(planCode);
    return void checkout(planCode);
  }

  async function buyPackage(code: string) {
    setBusy("pkg:" + code);
    setAviso(null);
    try {
      const r = await api<{ url?: string; mock?: boolean }>("/billing/buy-package", { method: "POST", body: JSON.stringify({ code }) });
      if (r.mock) {
        await api("/billing/mock-confirm", { method: "POST", body: JSON.stringify({ planCode: `pkg:${code}` }) });
        setAviso({ kind: "ok", text: "Créditos acreditados (pago de PRUEBA, sin cobro real)." });
        await load();
      } else if (r.url) {
        window.location.href = r.url;
      } else {
        setAviso({ kind: "error", text: "No pudimos abrir el pago. Inténtalo de nuevo en un momento." });
      }
    } catch (e) {
      setAviso({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  function planPrice(p: Plan): number | null {
    if (p.custom) return null;
    if (interval === "yearly") return currency === "CLP" ? p.priceClpYearly : p.priceUsdYearly;
    return currency === "CLP" ? p.priceClp : p.priceUsd;
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Cobros</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Tus créditos, tu plan y tus pagos.</p>

        {/* Aviso del retorno de la pasarela / de la tarjeta. Siempre arriba y anunciado. */}
        <div aria-live="polite" role="status">
          {aviso ? (
            <div
              className="card"
              data-cobros-aviso={aviso.kind}
              style={{ padding: "14px 16px", marginBottom: 16, borderLeft: `4px solid ${AVISO_COLOR[aviso.kind]}`, display: "flex", gap: 12, alignItems: "flex-start" }}
            >
              <p style={{ margin: 0, fontSize: 14, flex: 1 }}>{aviso.text}</p>
              <button
                onClick={() => setAviso(null)}
                aria-label="Cerrar aviso"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-dim)", fontSize: 18, lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          ) : null}
        </div>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {/* Créditos */}
        {s ? (
          <div className="card" style={{ padding: 22, marginBottom: 16 }}>
            <p className="text-dim" style={{ margin: 0, fontSize: 13 }}>{s.unit === "conversation" ? "Conversaciones disponibles" : "Créditos disponibles"}</p>
            <p className="display" style={{ margin: "4px 0 6px", fontSize: 40 }}>{s.balance.toLocaleString("es-CL")}</p>
            {/* CRE 3 — EL MEDIDOR, la misma traducción que se ve en Inicio y que usa el
                copiloto: un saldo en créditos no significa nada hasta decirle a cuántas
                conversaciones y cuántos días equivale a SU ritmo. La explicación de dónde
                sale el número va visible, no escondida en un tooltip: una estimación que no
                se puede auditar es una cifra que el dueño no va a creer. */}
            {s.medidor ? (
              <div style={{ margin: "0 0 14px" }}>
                <p style={{ margin: 0, fontSize: 14.5 }}>
                  ≈ <b style={{ fontVariantNumeric: "tabular-nums" }}>{s.medidor.conversaciones.toLocaleString("es-CL")}</b> conversaciones
                  {s.medidor.dias != null && s.medidor.dias > 0 ? <> · ≈ <b style={{ fontVariantNumeric: "tabular-nums" }}>{s.medidor.dias.toLocaleString("es-CL")}</b> días a tu ritmo</> : null}
                </p>
                <p className="text-dim" style={{ margin: "3px 0 0", fontSize: 12 }}>{s.medidor.explicacion}</p>
              </div>
            ) : null}
            {s.included > 0 ? (
              <>
                <div style={{ height: 10, borderRadius: 999, background: "var(--acc-dim)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, s.pctUsed)}%`, background: barColor(s.pctUsed) }} />
                </div>
                <p className="text-dim" style={{ fontSize: 13, margin: "8px 0 0" }}>
                  Consumidos {s.consumed.toLocaleString("es-CL")} de {s.included.toLocaleString("es-CL")} este mes ({s.pctUsed}%) · proyección {s.projected.toLocaleString("es-CL")}
                </p>
              </>
            ) : (
              <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Consumidos este mes: {s.consumed.toLocaleString("es-CL")}</p>
            )}
            {Object.keys(s.byCategory).length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {Object.entries(s.byCategory).map(([cat, n]) => (
                  <span key={cat} className="text-dim" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)" }}>{CAT_LABEL[cat] ?? cat}: {n.toLocaleString("es-CL")}</span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Comprar créditos */}
        {pkgs.length ? (
          <>
            <h2 className="display" style={{ fontSize: 18, margin: "22px 0 12px" }} data-copilot="comprar-creditos">Comprar créditos</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
              {pkgs.map((p) => (
                <div key={p.code} className="card" style={{ padding: 18, display: "flex", flexDirection: "column" }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{p.name}</p>
                  <p className="display" style={{ margin: "6px 0 0", fontSize: 24 }}>{p.credits.toLocaleString("es-CL")}</p>
                  {/* §1 — el bono lo manda el servidor YA CALCULADO desde el precio y los
                      créditos. Es la misma cifra que la página pública, porque sale del mismo
                      cálculo y no de un número escrito en cada pantalla. */}
                  {(p.bonoPct ?? 0) > 0 ? (
                    <p style={{ fontSize: 12, fontWeight: 700, color: "var(--ok)", margin: "2px 0 0" }}>+{p.bonoPct}% de créditos extra</p>
                  ) : null}
                  <p className="text-dim" style={{ fontSize: 12, margin: "0 0 12px" }}>créditos · {money(p.priceClp, p.priceUsd)} · IVA incluido</p>
                  <button className="btn-accent" onClick={() => buyPackage(p.code)} disabled={busy === "pkg:" + p.code} style={{ marginTop: "auto", opacity: busy === "pkg:" + p.code ? 0.6 : 1 }}>
                    {busy === "pkg:" + p.code ? "Abriendo pago…" : "Comprar"}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* Plan */}
        {plans.length ? (
          <>
            <div data-copilot="plan" style={{ display: "flex", alignItems: "center", gap: 12, margin: "28px 0 12px" }}>
              <h2 className="display" style={{ fontSize: 18, margin: 0 }}>Plan</h2>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4, background: "var(--acc-dim)", borderRadius: 999, padding: 3 }}>
                {(["monthly", "yearly"] as const).map((iv) => (
                  <button key={iv} onClick={() => setIntervalSel(iv)} style={{ padding: "5px 12px", borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: interval === iv ? "var(--acc)" : "transparent", color: interval === iv ? "var(--acc-ink)" : "var(--ink-dim)" }}>
                    {iv === "monthly" ? "Mensual" : "Anual"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {plans.map((p) => {
                const current = me?.plan?.code === p.code;
                const price = planPrice(p);
                const unavailable = !p.custom && (price == null || price <= 0);
                const working = busy === "plan:" + p.code || busy === "card:" + p.code;
                return (
                  <div key={p.code} className="card" style={{ padding: 18, border: current ? "none" : undefined, boxShadow: current ? "inset 0 0 0 2px var(--acc)" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>{p.name}</p>
                      {current ? <span style={{ fontSize: 11, fontWeight: 700, color: "var(--acc-deep)", background: "var(--acc-dim)", borderRadius: 999, padding: "2px 8px" }}>Actual</span> : null}
                    </div>
                    <p className="display" style={{ margin: "8px 0 0", fontSize: 24 }}>{p.custom ? "A medida" : price != null && price > 0 ? money(p.priceClp === 0 ? 0 : price, price) : "—"}</p>
                    <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 14px" }}>{p.custom ? "según tu caso" : interval === "yearly" ? "al año" : "al mes"}</p>
                    {current ? (
                      <button disabled className="btn-accent" style={{ width: "100%", opacity: 0.5, cursor: "default" }}>Tu plan</button>
                    ) : p.custom ? (
                      <a href="/conversaciones" className="btn-accent" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>Hablar con nosotros</a>
                    ) : (
                      <button className="btn-accent" data-copilot={`cobros-contratar-${p.code}`} onClick={() => contratar(p.code)} disabled={unavailable || working} style={{ width: "100%", opacity: unavailable || working ? 0.5 : 1 }}>
                        {unavailable ? "Sin precio " + (interval === "yearly" ? "anual" : "mensual") : working ? "Abriendo pago…" : "Contratar"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {me?.subscription ? (
              <p className="text-dim" style={{ fontSize: 12, margin: "12px 0 0" }}>
                Suscripción: {subEstado(me.subscription.status)}{me.subscription.periodEnd ? ` · próximo período ${new Date(me.subscription.periodEnd).toLocaleDateString("es-CL")}` : ""}
              </p>
            ) : null}
            <p className="text-dim" style={{ fontSize: 12, margin: "6px 0 0" }}>Pagas con {currency === "CLP" ? "Flow (tarjetas chilenas)" : "tarjeta internacional"}. Al confirmar te llevamos a la pasarela.</p>
          </>
        ) : null}

        {/* CRE 2 (§6) — recarga automática: solo con Flow (tarjeta guardada) */}
        {conFlow ? <RecargaAutomatica tieneTarjeta={Boolean(me?.paymentMethod)} /> : null}

        {/* CRE 3 — lo que cobra Meta, informativo (Conversia no lo cobra). */}
        <CostosDeMeta />

        {/* Método de pago (cobro automático con tarjeta en Flow) */}
        {conFlow ? (
          <div className="card" data-copilot="cobros-metodo-pago" style={{ padding: 22, marginTop: 24 }}>
            <h2 className="display" style={{ fontSize: 18, margin: "0 0 6px" }}>Método de pago</h2>
            {me?.paymentMethod ? (
              <>
                <p style={{ margin: "0 0 4px", fontSize: 14 }}>
                  <span style={{ color: "var(--ok)", fontWeight: 700 }}>●</span> Tarjeta registrada
                  {me.paymentMethod.brand ? ` · ${me.paymentMethod.brand}` : ""}
                  {me.paymentMethod.last4 ? ` ···· ${me.paymentMethod.last4}` : ""}
                </p>
                <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>
                  Tu plan se renueva solo en cada fecha; no tienes que pagar a mano. Nunca guardamos los datos de tu tarjeta.
                </p>
                <button
                  className="btn-accent"
                  data-copilot="cobros-registrar-tarjeta"
                  onClick={() => { if (planContratado) void registrarTarjeta(planContratado); }}
                  disabled={!planContratado || tarjetaEnCurso}
                  style={{ opacity: !planContratado || tarjetaEnCurso ? 0.5 : 1 }}
                >
                  {tarjetaEnCurso ? "Abriendo Flow…" : "Cambiar tarjeta"}
                </button>
              </>
            ) : (
              <>
                <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>
                  Registra tu tarjeta una sola vez en la página segura de Flow (nunca guardamos sus datos) y tu plan se
                  cobra solo en cada fecha de renovación. Puedes cambiarla o cancelar cuando quieras.
                </p>
                <button
                  className="btn-accent"
                  data-copilot="cobros-registrar-tarjeta"
                  onClick={() => { if (planContratado) void registrarTarjeta(planContratado); }}
                  disabled={!planContratado || tarjetaEnCurso}
                  style={{ opacity: !planContratado || tarjetaEnCurso ? 0.5 : 1 }}
                >
                  {busy === "card" ? "Confirmando tarjeta…" : tarjetaEnCurso ? "Abriendo Flow…" : "Registrar mi tarjeta"}
                </button>
                {!planContratado ? (
                  <p className="text-dim" style={{ fontSize: 12, margin: "10px 0 0" }}>
                    Primero elige tu plan aquí arriba: al contratarlo registras la tarjeta en el mismo paso.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </main>
    </AppShell>
  );
}

/* ─────────────────────── CRE 2 (§6) — RECARGA AUTOMÁTICA ───────────────────────
 * Cuando el saldo baja del umbral, cobramos un pack a la tarjeta guardada para que el bot
 * no se corte. Es plata del cliente saliendo sin que él apriete nada, así que la pantalla
 * es explícita en las tres cosas que la decisión del dueño (§6) exige: qué se cobra, con
 * qué tope, y una casilla de consentimiento que hay que marcar para activarla.
 *
 * Hasta este PR esta pantalla no existía (y nada disparaba la recarga): el cliente no
 * tenía forma de activarla ni de saber que existía.
 */
type AutoRecargaCfg = {
  unit?: "conversation" | "credit";
  enabled: boolean;
  thresholdRemaining: number;
  packCode: string | null;
  monthlyCapClp: number;
  consentAt: string | null;
  packs: Array<{ code: string; name: string; credits: number; priceClp: number; bonoPct?: number; topeMaximoClp?: number }>;
  /** Cuántas recargas del pack elegido acepta el servidor como tope mensual. */
  maxRecargasMes?: number;
};

/** La recarga automática es solo con Flow, o sea CLP: formateador local y explícito. */
const clpRec = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

/**
 * CRE 3 — LO QUE COBRA META, informativo.
 *
 * Decisión del dueño (27-oct): cada cliente paga a Meta con SU tarjeta. Al cliente le
 * llegan dos cobros y hasta ahora el panel solo le mostraba uno: veía su plan de Conversia
 * y no tenía dónde enterarse de cuánto le está cobrando Meta por los mensajes. Un cargo que
 * aparece en la tarjeta sin explicación en ninguna parte termina en un reclamo.
 *
 * Si no hay mensajes cobrados en el mes la tarjeta NO aparece: mostrar "$0" invita a
 * preguntarse por un cobro que no existe.
 */
function CostosDeMeta() {
  const [c, setC] = useState<MetaCostos | null>(null);
  useEffect(() => {
    api<MetaCostos>("/billing/meta-costs").then(setC).catch(() => setC(null));
  }, []);
  if (!c || c.mensajes === 0) return null;
  const cats = Object.entries(c.porCategoria).sort((a, b) => b[1].usd - a[1].usd);
  return (
    <div className="card" data-copilot="costos-meta" style={{ padding: 22, marginTop: 24 }}>
      <h2 className="display" style={{ fontSize: 18, margin: "0 0 6px" }}>Lo que te cobra Meta este mes</h2>
      <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px", lineHeight: 1.5 }}>
        Son dos cobros distintos: <b>Conversia te cobra el plan</b> y <b>Meta te cobra aparte</b> ciertos mensajes
        de WhatsApp, directo a la tarjeta que tengas cargada en tu cuenta de Meta. Esto es solo informativo —
        nosotros no cobramos este monto.
      </p>
      <p className="display" style={{ margin: 0, fontSize: 30 }}>
        US${c.usd.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
      <p className="text-dim" style={{ fontSize: 12.5, margin: "2px 0 0" }}>
        ≈ ${c.clpAprox.toLocaleString("es-CL")} aproximados ({c.mensajes.toLocaleString("es-CL")} mensajes cobrados).
        Meta factura en dólares, así que el monto en pesos depende del cambio del día.
      </p>
      {cats.length ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {cats.map(([cat, v]) => (
            <span key={cat} className="text-dim" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)" }}>
              {CAT_LABEL[cat] ?? cat}: US${v.usd.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · {v.mensajes.toLocaleString("es-CL")}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecargaAutomatica({ tieneTarjeta }: { tieneTarjeta: boolean }) {
  const [cfg, setCfg] = useState<AutoRecargaCfg | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Tope que está GUARDADO en el servidor. Subir el tope es autorizar más plata, así que la
  // pantalla vuelve a pedir la casilla (y el servidor lo exige igual). Sin esto, el
  // consentimiento dado por $249.900 valía para cualquier cifra que se escribiera después.
  const [topeGuardado, setTopeGuardado] = useState<number | null>(null);

  useEffect(() => {
    api<AutoRecargaCfg>("/billing/auto-recharge")
      .then((r) => { setCfg(r); setConsent(Boolean(r.consentAt)); setTopeGuardado(r.monthlyCapClp); })
      .catch(() => setCfg(null));
  }, []);

  if (!cfg) return null;
  const unidad = cfg.unit === "credit" ? "créditos" : "conversaciones";
  const pack = cfg.packs.find((p) => p.code === cfg.packCode) ?? cfg.packs[0] ?? null;
  const topeVeces = pack && pack.priceClp > 0 ? Math.floor(cfg.monthlyCapClp / pack.priceClp) : 0;
  const topeMaximo = pack?.topeMaximoClp ?? (pack ? pack.priceClp * (cfg.maxRecargasMes ?? 10) : 0);
  const subeElTope = topeGuardado != null && cfg.monthlyCapClp > topeGuardado;
  const sobreElTecho = topeMaximo > 0 && cfg.monthlyCapClp > topeMaximo;
  // Para guardar hacen falta las tres: la casilla marcada, un tope dentro del techo, y —si
  // el tope SUBE— la casilla marcada en ESTA edición.
  const puedeGuardar = consent && !sobreElTecho && !(subeElTope && !consent);

  async function guardar(enabled: boolean, cambios: Partial<AutoRecargaCfg> = {}) {
    setBusy(true);
    setMsg(null);
    try {
      const body = {
        enabled,
        consent,
        thresholdRemaining: cambios.thresholdRemaining ?? cfg!.thresholdRemaining,
        packCode: (cambios.packCode ?? cfg!.packCode ?? pack?.code) || undefined,
        monthlyCapClp: cambios.monthlyCapClp ?? cfg!.monthlyCapClp,
      };
      const r = await api<AutoRecargaCfg & { ok: boolean }>("/billing/auto-recharge", { method: "PUT", body: JSON.stringify(body) });
      setCfg({ ...cfg!, ...r });
      setTopeGuardado(r.monthlyCapClp ?? body.monthlyCapClp);
      setMsg(enabled ? "Recarga automática activada." : "Recarga automática desactivada.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-copilot="cobros-recarga-automatica" style={{ padding: 22, marginTop: 24 }}>
      <h2 className="display" style={{ fontSize: 18, margin: "0 0 6px" }}>Recarga automática</h2>
      <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>
        {pack
          ? `Cuando te queden menos de ${cfg.thresholdRemaining} ${unidad}, cobramos ${pack.name.toLowerCase()} (${clpRec(pack.priceClp)}) a tu tarjeta para que tu asistente no se corte. Se dispara antes de llegar a cero, mientras el pago se procesa.`
          : "Todavía no hay packs disponibles para recargar."}
      </p>

      {!tieneTarjeta ? (
        <p className="text-dim" style={{ fontSize: 12.5, margin: 0 }}>
          Primero registra tu tarjeta más abajo: sin tarjeta guardada no podemos recargar solos.
        </p>
      ) : !pack ? null : (
        <>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13.5, cursor: "pointer", marginBottom: 12 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
            <span>
              Autorizo a cobrar <b>{clpRec(pack.priceClp)}</b> a mi tarjeta cuando mis {unidad} se estén agotando,
              con un tope de <b>{clpRec(cfg.monthlyCapClp)}</b> al mes{topeVeces > 0 ? ` (hasta ${topeVeces} ${topeVeces === 1 ? "recarga" : "recargas"})` : ""}.
              Puedo desactivarlo cuando quiera.
            </span>
          </label>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
            {cfg.packs.length > 1 ? (
              <label style={{ fontSize: 12.5 }}>
                <span className="text-dim" style={{ display: "block", marginBottom: 4 }}>Qué recargar</span>
                <select
                  value={pack.code}
                  onChange={(e) => setCfg({ ...cfg, packCode: e.target.value })}
                  disabled={busy}
                  style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)" }}
                >
                  {cfg.packs.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.credits.toLocaleString("es-CL")} {unidad} · {clpRec(p.priceClp)}
                      {(p.bonoPct ?? 0) > 0 ? ` (+${p.bonoPct}% extra)` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label style={{ fontSize: 12.5 }}>
              <span className="text-dim" style={{ display: "block", marginBottom: 4 }}>Avisar y recargar bajo</span>
              <input
                type="number"
                min={1}
                value={cfg.thresholdRemaining}
                onChange={(e) => setCfg({ ...cfg, thresholdRemaining: Math.max(1, Number(e.target.value) || 1) })}
                disabled={busy}
                style={{ width: 110, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)" }}
              />
            </label>
            <label style={{ fontSize: 12.5 }}>
              <span className="text-dim" style={{ display: "block", marginBottom: 4 }}>Tope mensual (CLP)</span>
              <input
                type="number"
                min={pack.priceClp}
                step={pack.priceClp}
                max={topeMaximo || undefined}
                value={cfg.monthlyCapClp}
                onChange={(e) => setCfg({ ...cfg, monthlyCapClp: Math.max(0, Number(e.target.value) || 0) })}
                disabled={busy}
                style={{ width: 140, padding: "7px 10px", borderRadius: 8, border: `1px solid ${sobreElTecho ? "var(--danger, #c33)" : "var(--hairline)"}`, background: "var(--surface)", color: "var(--ink)" }}
              />
              {/* El techo lo manda el servidor (10 recargas del pack elegido) y acá se dice,
                  para que la pantalla no ofrezca un número que la API va a rechazar. */}
              <span className="text-dim" style={{ display: "block", fontSize: 11.5, marginTop: 4 }}>
                {sobreElTecho
                  ? `Máximo ${clpRec(topeMaximo)} (${cfg.maxRecargasMes ?? 10} recargas de este pack).`
                  : `Hasta ${clpRec(topeMaximo)}.`}
              </span>
            </label>
          </div>
          {subeElTope ? (
            <p className="text-dim" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
              Estás <b>subiendo el tope</b>: vuelve a marcar la autorización de arriba, porque autoriza más gasto que el
              que habías aceptado.
            </p>
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {cfg.enabled ? (
              <>
                <span style={{ fontSize: 13, color: "var(--ok)", fontWeight: 600 }}>● Activada</span>
                <button onClick={() => void guardar(true)} disabled={busy || !puedeGuardar} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px" }}>
                  Guardar cambios
                </button>
                <button onClick={() => void guardar(false)} disabled={busy} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px" }}>
                  Desactivar
                </button>
              </>
            ) : (
              <button onClick={() => void guardar(true)} disabled={busy || !puedeGuardar} className="btn-accent" style={{ border: "none", cursor: busy || !puedeGuardar ? "not-allowed" : "pointer", fontSize: 13, padding: "8px 14px", opacity: busy || !puedeGuardar ? 0.5 : 1 }}>
                {busy ? "Guardando…" : "Activar recarga automática"}
              </button>
            )}
          </div>
          {!consent && !cfg.enabled ? (
            <p className="text-dim" style={{ fontSize: 12, margin: "10px 0 0" }}>Marca la autorización para poder activarla.</p>
          ) : null}
          {msg ? <p className="text-dim" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{msg}</p> : null}
        </>
      )}
    </div>
  );
}
