"use client";

/**
 * Plan y facturación del tenant: plan actual con límites, uso del período con
 * barras, catálogo completo de planes (Enterprise incluido), facturas y pago
 * con la pasarela ya configurada (Flow CLP / Lemon Squeezy USD / Mock en dev).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard } from "lucide-react";
import { api } from "@/lib/api";
import { SubscriptionSelfService } from "./subscription-self-service";
import { WalletCard } from "./wallet-card";
import { money } from "@/lib/safe";
import { Button, ConfirmDialog, Skeleton, StatusBadge, cn, useToast } from "@/components/ui";
import { UsageBars } from "@/components/usage-bars";

interface Plan {
  code: string;
  name: string;
  priceClp: number;
  priceUsd: number;
  priceClpYearly: number | null;
  priceUsdYearly: number | null;
  interval: string;
  isPublic: boolean;
  custom: boolean;
  limits: Record<string, number | null>;
}
interface Overview {
  organization: { name: string; status: string; currency: string };
  plan: { code: string; name: string; priceClp: number; priceUsd: number; priceClpYearly: number | null; priceUsdYearly: number | null; interval: string; custom: boolean } | null;
  billables: Array<{ concept: string; amount: number }>;
  subscription: { status: string; periodEnd: string | null; interval: string } | null;
  usage: Record<string, { used: number; limit: number | null }>;
  invoices: { id: string; number: string; status: string; currency: string; amountDue: number; createdAt: string; dueAt: string | null; paidAt: string | null }[];
  paymentMethod: { provider: string; brand: string | null; last4: string | null } | null;
  paymentProvider: string;
}

const LIMIT_LABELS: Record<string, string> = {
  users: "usuarios",
  agents: "agentes IA",
  channels: "canales",
  workflows: "flujos",
  clinics: "sedes",
  aiTokensDaily: "tokens IA/día",
};
const PROVIDER_LABELS: Record<string, string> = {
  flow: "Flow (CLP)",
  lemonsqueezy: "Lemon Squeezy (USD)",
  stripe: "Stripe",
  mock: "Pago de prueba (desarrollo)",
};
const INVOICE_STATUS: Record<string, { label: string; kind: "connected" | "beta" | "error" | "soon" }> = {
  PAID: { label: "Pagada", kind: "connected" },
  OPEN: { label: "Pendiente", kind: "beta" },
  DRAFT: { label: "Borrador", kind: "soon" },
  VOID: { label: "Anulada", kind: "soon" },
  UNCOLLECTIBLE: { label: "Incobrable", kind: "error" },
};


export default function BillingPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [changing, setChanging] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [mockBanner, setMockBanner] = useState(false);
  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("monthly");

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([api<Overview>("/billing/me"), api<Plan[]>("/billing/plans")]);
    setData(o);
    setPlans(p);
    return { overview: o, plans: p };
  }, []);
  // Checkout directo al llegar con ?plan=starter|pro (registro público / link del
  // bot de ventas): se dispara una sola vez y se limpia la URL para no repetirlo.
  const autoCheckout = useRef(false);
  useEffect(() => {
    void load()
      .then(({ overview, plans: catalog }) => {
        if (autoCheckout.current) return;
        const params = new URLSearchParams(window.location.search);
        const wanted = params.get("plan");
        if (!wanted) return;
        const wantedInterval = params.get("interval") === "yearly" ? "yearly" : "monthly";
        if (wantedInterval === "yearly") setBillingInterval("yearly");
        autoCheckout.current = true;
        window.history.replaceState(null, "", window.location.pathname);
        const target = catalog.find((p) => p.code === wanted && p.isPublic);
        if (!target || target.code === overview.plan?.code) return;
        pay(target.code, wantedInterval);
      })
      .catch(() => setData(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  /**
   * Con FLOW, contratar un plan va SIEMPRE por la suscripción con tarjeta
   * (registro + primer cobro + renovación automática): es la garantía de pago
   * mensual y evita que la plataforma se corte por olvido. El checkout de pago
   * único (Khipu/transferencias) NO sirve para cobro recurrente, así que no se
   * ofrece como puerta de entrada.
   */
  async function subscribeWithCard(planCode: string, interval: "monthly" | "yearly" = billingInterval) {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/billing/subscription/start", {
        method: "POST",
        body: JSON.stringify({ planCode, billingInterval: interval }),
      });
      window.location.href = r.url; // registro de tarjeta en Flow → vuelve con ?card=1
    } catch (err) {
      // Cuenta de Flow sin cobro automático habilitado aún: no bloqueamos el
      // pago — caemos al checkout de pago único mientras Flow activa el servicio.
      if ((err as Error).message.includes("FLOW_NO_AUTO_CHARGE")) {
        toast.push("Procesando como pago único (el cobro automático de Flow aún no está habilitado)", "info");
        await checkout(planCode, interval);
        return;
      }
      toast.push((err as Error).message, "error");
      setBusy(false);
    }
  }

  /** Puerta única de pago: Flow → suscripción con tarjeta; otros → checkout clásico. */
  function pay(planCode: string, interval: "monthly" | "yearly" = billingInterval) {
    if (data?.paymentProvider === "flow") return void subscribeWithCard(planCode, interval);
    return void checkout(planCode, interval);
  }

  async function checkout(planCode: string, interval: "monthly" | "yearly" = billingInterval) {
    setBusy(true);
    try {
      const session = await api<{ url: string; mock: boolean }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode, billingInterval: interval }) });
      if (session.mock) {
        // Dev: sin pasarela — se confirma simulado con banner claro.
        setMockBanner(true);
        await api("/billing/mock-confirm", { method: "POST", body: JSON.stringify({ planCode, billingInterval: interval }) });
        toast.push("Pago de PRUEBA confirmado (sin cobro real) ✔", "ok");
        await load();
      } else {
        window.location.href = session.url; // checkout real de la pasarela
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
      setChanging(null);
    }
  }

  // Skeleton con la FORMA del contenido real (B4): plan actual + bolsa + grilla
  // de 4 planes, en vez de un bloque gris genérico.
  if (!data)
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-7 w-48" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40 rounded-card" />
          <Skeleton className="h-40 rounded-card" />
        </div>
        <Skeleton className="h-4 w-40" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-card" />
          ))}
        </div>
      </div>
    );

  const currency = data.organization.currency ?? "CLP";
  const currentCode = data.plan?.code ?? null;
  const currentPlanFull = plans.find((p) => p.code === currentCode) ?? null;
  type Priced = { priceClp: number; priceUsd: number; priceClpYearly: number | null; priceUsdYearly: number | null };
  const yearlyPriceOf = (p: Priced): number | null => (currency === "CLP" ? p.priceClpYearly : p.priceUsdYearly);
  const anyYearly = plans.some((p) => p.isPublic && (yearlyPriceOf(p) ?? 0) > 0);
  // Precio a una cadencia dada (cae a mensual si el plan no tiene anual).
  const priceAt = (p: Priced, interval: "monthly" | "yearly") => {
    if (interval === "yearly") {
      const y = yearlyPriceOf(p);
      if (y && y > 0) return y;
    }
    return currency === "CLP" ? p.priceClp : p.priceUsd;
  };
  const priceOf = (p: Priced) => priceAt(p, billingInterval); // catálogo: según el toggle
  const cadence = billingInterval === "yearly" ? "año" : "mes";

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold">Plan y facturación</h1>
      <p className="mb-4 text-sm text-ink-muted">Tu plan, el consumo del período y tus pagos.</p>

      {mockBanner && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/40">
          🧪 Pago de prueba — entorno sin pasarela real: no se realizó ningún cobro.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* -------- Plan actual -------- */}
        <div className="rounded-card border border-line bg-panel p-5 shadow-card">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink-muted">Plan actual</p>
            {data.subscription && (
              <StatusBadge
                kind={data.subscription.status === "ACTIVE" ? "connected" : data.subscription.status === "TRIALING" ? "beta" : "error"}
                label={data.subscription.status === "ACTIVE" ? "Activo" : data.subscription.status === "TRIALING" ? "Prueba" : data.subscription.status}
              />
            )}
          </div>
          {data.plan ? (
            <>
              <p className="mt-1 text-2xl font-semibold text-brand-800 dark:text-brand-300">{data.plan.name}</p>
              {(() => {
                const base = priceAt(data.plan, data.plan.interval === "yearly" ? "yearly" : "monthly");
                const billTotal = data.billables.reduce((a, b) => a + (Number(b.amount) || 0), 0);
                const cad = data.plan.interval === "yearly" ? "año" : "mes";
                return (
                  <>
                    <p className="text-sm text-ink-muted">
                      {data.plan.custom && billTotal > 0 && <span className="text-ink-subtle">Base </span>}
                      {money(base, currency)} / {cad}
                      {data.subscription?.periodEnd && (
                        <span className="text-ink-subtle"> · renueva el {new Date(data.subscription.periodEnd).toLocaleDateString("es-CL")}</span>
                      )}
                    </p>
                    {data.billables.length > 0 && (
                      <div className="mt-2 rounded-lg bg-app p-2 text-xs text-ink-muted">
                        <p className="font-medium text-ink-muted">Facturables a medida</p>
                        {data.billables.map((b, i) => (
                          <div key={i} className="flex justify-between"><span>{b.concept}</span><span>{money(Number(b.amount), currency)}</span></div>
                        ))}
                        <div className="mt-1 flex justify-between border-t border-line pt-1 font-semibold text-ink">
                          <span>Total / {cad}</span><span>{money(base + billTotal, currency)}</span>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
              {currentPlanFull && (
                <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-muted">
                  {Object.entries(currentPlanFull.limits ?? {}).map(([k, v]) => (
                    <li key={k}>• {v == null || v === 0 ? "∞" : Number(v).toLocaleString("es-CL")} {LIMIT_LABELS[k] ?? k}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-ink-subtle">Sin plan asignado — elige uno abajo o contacta a TuBot.</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button onClick={() => (data.plan ? pay(data.plan.code) : undefined)} disabled={busy || !data.plan}>
              <CreditCard size={14} /> Pagar ahora
            </Button>
            <span className="text-xs text-ink-subtle">
              vía <b>{PROVIDER_LABELS[data.paymentProvider] ?? data.paymentProvider}</b>
              {data.paymentMethod?.last4 && ` · ${data.paymentMethod.brand ?? "tarjeta"} •••• ${data.paymentMethod.last4}`}
            </span>
          </div>
        </div>

        {/* -------- Uso del período (componente único de barras) -------- */}
        <div className="rounded-card border border-line bg-panel p-5 shadow-card">
          <p className="mb-3 text-sm font-medium text-ink-muted">Uso del período</p>
          <UsageBars usage={data.usage} />
        </div>
      </div>

      {/* -------- Bolsa de mensajes de plantilla (única tarjeta del tema) -------- */}
      <WalletCard />

      {/* -------- Suscripción automática (autogestión) -------- */}
      <SubscriptionSelfService planCode={data.plan?.code ?? null} interval={billingInterval} />

      {/* -------- Planes disponibles -------- */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-subtle">Planes disponibles</h2>
        {anyYearly && (
          <div className="inline-flex rounded-lg border border-line-strong p-0.5 text-xs">
            <button
              onClick={() => setBillingInterval("monthly")}
              className={cn("rounded-md px-3 py-1.5 font-medium", billingInterval === "monthly" ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-app")}
            >
              Mensual
            </button>
            <button
              onClick={() => setBillingInterval("yearly")}
              className={cn("rounded-md px-3 py-1.5 font-medium", billingInterval === "yearly" ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-app")}
            >
              Anual
            </button>
          </div>
        )}
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => {
          const isCurrent = p.code === currentCode;
          const enterprise = !p.isPublic;
          return (
            <div key={p.code} className={cn("flex flex-col rounded-card border bg-panel p-4 shadow-card", isCurrent ? "border-brand-400 ring-1 ring-brand-200" : "border-line")}>
              <div className="flex min-h-[1.5rem] items-start justify-between gap-2">
                <p className="t-card text-ink">{p.name}</p>
                {isCurrent && <span className="shrink-0 rounded-pill bg-brand-100 px-2 py-0.5 t-meta font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">Tu plan actual</span>}
              </div>
              {(() => {
                const showYearly = billingInterval === "yearly" && (yearlyPriceOf(p) ?? 0) > 0;
                // Altura fija en el bloque de precio: así las viñetas de las 4
                // tarjetas arrancan en la misma línea base (antes «/mes» de la
                // tarjeta Enterprise caía aparte y desalineaba todo).
                return (
                  <p className="mt-1 flex min-h-[2rem] items-baseline gap-1 text-xl font-semibold text-ink">
                    {p.custom && <span className="text-xs font-normal text-ink-subtle">Desde</span>}
                    <span>{enterprise && priceOf(p) === 0 ? "A medida" : money(priceOf(p), currency)}</span>
                    {!(enterprise && priceOf(p) === 0) && <span className="text-xs font-normal text-ink-subtle">/{showYearly ? "año" : "mes"}</span>}
                  </p>
                );
              })()}
              <ul className="mt-2 flex-1 space-y-0.5 text-[11px] text-ink-muted">
                {Object.entries(p.limits ?? {}).slice(0, 5).map(([k, v]) => (
                  <li key={k}>• {v == null || v === 0 ? "∞" : Number(v).toLocaleString("es-CL")} {LIMIT_LABELS[k] ?? k}</li>
                ))}
              </ul>
              <div className="mt-3">
                {isCurrent ? (
                  <Button variant="secondary" className="w-full" disabled>Tu plan actual</Button>
                ) : enterprise && priceOf(p) === 0 ? (
                  <a href="mailto:contacto@tubot.cl?subject=Plan%20Enterprise" className="block rounded-lg border border-line-strong py-2 text-center text-sm font-medium text-ink-muted hover:bg-app">
                    Contactar a TuBot
                  </a>
                ) : (
                  <Button variant="secondary" className="w-full" onClick={() => setChanging(p)} disabled={busy}>
                    Cambiar a este plan
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* -------- Facturas -------- */}
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-ink-subtle">Facturas</h2>
      {data.invoices.length === 0 ? (
        <p className="mt-2 rounded-card border border-dashed border-line bg-panel p-6 text-center text-sm text-ink-subtle">
          Aún no tienes facturas — aparecerán aquí con tu primer pago.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-card border border-line bg-panel shadow-card">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase text-ink-subtle">
                <th className="p-2.5">N°</th>
                <th className="p-2.5">Fecha</th>
                <th className="p-2.5">Vencimiento</th>
                <th className="p-2.5">Monto</th>
                <th className="p-2.5">Estado</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((inv) => {
                const st = INVOICE_STATUS[inv.status] ?? { label: inv.status, kind: "soon" as const };
                return (
                  <tr key={inv.id} className="border-b border-line">
                    <td className="p-2.5 font-mono">{inv.number}</td>
                    <td className="p-2.5">{new Date(inv.createdAt).toLocaleDateString("es-CL")}</td>
                    <td className="p-2.5">{inv.dueAt ? new Date(inv.dueAt).toLocaleDateString("es-CL") : "—"}</td>
                    <td className="p-2.5">{money(Number(inv.amountDue), inv.currency)}</td>
                    <td className="p-2.5"><StatusBadge kind={st.kind} label={st.label} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-line px-3 py-2 text-[10px] text-ink-subtle">
            Descarga en PDF: disponible pronto — si necesitas una factura formal escríbenos a contacto@tubot.cl.
          </p>
        </div>
      )}

      {/* Confirmación de cambio de plan: qué gana/pierde */}
      <ConfirmDialog
        open={changing !== null}
        onClose={() => setChanging(null)}
        onConfirm={() => changing && pay(changing.code)}
        title={`¿Cambiar al plan ${changing?.name}?`}
        description={
          changing
            ? `Pasarás de ${data.plan?.name ?? "sin plan"} a ${changing.name} por ${money(priceOf(changing), currency)}/${cadence} (facturación ${billingInterval === "yearly" ? "anual" : "mensual"}). Nuevos límites: ${Object.entries(changing.limits ?? {})
                .map(([k, v]) => `${v == null || v === 0 ? "∞" : v} ${LIMIT_LABELS[k] ?? k}`)
                .join(" · ")}. Si bajas de plan y excedes un límite, no podrás crear más elementos de ese tipo (lo existente no se borra). ${
                data.paymentProvider === "flow"
                  ? "Registrarás tu tarjeta una sola vez (Webpay) y el cobro se renueva automáticamente cada período — tu servicio nunca se corta por un olvido de pago."
                  : `El pago se procesa con ${PROVIDER_LABELS[data.paymentProvider] ?? data.paymentProvider}.`
              }`
            : ""
        }
        confirmLabel="Continuar al pago"
      />
    </div>
  );
}
