"use client";

/**
 * Plan y facturación del tenant: plan actual con límites, uso del período con
 * barras, catálogo completo de planes (Enterprise incluido), facturas y pago
 * con la pasarela ya configurada (Flow CLP / Lemon Squeezy USD / Mock en dev).
 */
import { useCallback, useEffect, useState } from "react";
import { CreditCard } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, Skeleton, StatusBadge, cn, useToast } from "@/components/ui";

interface Plan {
  code: string;
  name: string;
  priceClp: number;
  priceUsd: number;
  interval: string;
  isPublic: boolean;
  limits: Record<string, number | null>;
}
interface Overview {
  organization: { name: string; status: string; currency: string };
  plan: { code: string; name: string; priceClp: number; priceUsd: number; interval: string } | null;
  subscription: { status: string; periodEnd: string | null } | null;
  usage: Record<string, { used: number; limit: number | null }>;
  invoices: { id: string; number: string; status: string; currency: string; amountDue: number; createdAt: string; dueAt: string | null; paidAt: string | null }[];
  paymentMethod: { provider: string; brand: string | null; last4: string | null } | null;
  paymentProvider: string;
}

const USAGE_LABELS: Record<string, string> = {
  users: "Usuarios",
  agents: "Agentes IA",
  channels: "Canales",
  workflows: "Flujos",
  aiTokensToday: "Tokens IA (hoy)",
};
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

function money(amount: number, currency: string): string {
  return currency === "CLP" ? `$${amount.toLocaleString("es-CL")} CLP` : `US$ ${amount.toLocaleString("en-US")}`;
}

export default function BillingPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [changing, setChanging] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [mockBanner, setMockBanner] = useState(false);

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([api<Overview>("/billing/me"), api<Plan[]>("/billing/plans")]);
    setData(o);
    setPlans(p);
  }, []);
  useEffect(() => {
    void load().catch(() => setData(null));
  }, [load]);

  async function checkout(planCode: string) {
    setBusy(true);
    try {
      const session = await api<{ url: string; mock: boolean }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode }) });
      if (session.mock) {
        // Dev: sin pasarela — se confirma simulado con banner claro.
        setMockBanner(true);
        await api("/billing/mock-confirm", { method: "POST", body: JSON.stringify({ planCode }) });
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

  if (!data) return <div className="mx-auto max-w-4xl p-6"><Skeleton className="h-96" /></div>;

  const currency = data.organization.currency ?? "CLP";
  const currentCode = data.plan?.code ?? null;
  const currentPlanFull = plans.find((p) => p.code === currentCode) ?? null;
  const priceOf = (p: { priceClp: number; priceUsd: number }) => (currency === "CLP" ? p.priceClp : p.priceUsd);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-xl font-semibold">Plan y facturación</h1>
      <p className="mb-4 text-sm text-slate-500">Tu plan, el consumo del período y tus pagos.</p>

      {mockBanner && (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
          🧪 Pago de prueba — entorno sin pasarela real: no se realizó ningún cobro.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* -------- Plan actual -------- */}
        <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-500">Plan actual</p>
            {data.subscription && (
              <StatusBadge
                kind={data.subscription.status === "ACTIVE" ? "connected" : data.subscription.status === "TRIALING" ? "beta" : "error"}
                label={data.subscription.status === "ACTIVE" ? "Activo" : data.subscription.status === "TRIALING" ? "Prueba" : data.subscription.status}
              />
            )}
          </div>
          {data.plan ? (
            <>
              <p className="mt-1 text-2xl font-semibold text-cyan-800">{data.plan.name}</p>
              <p className="text-sm text-slate-500">
                {money(priceOf(data.plan), currency)} / {data.plan.interval === "year" ? "año" : "mes"}
                {data.subscription?.periodEnd && (
                  <span className="text-slate-400"> · renueva el {new Date(data.subscription.periodEnd).toLocaleDateString("es-CL")}</span>
                )}
              </p>
              {currentPlanFull && (
                <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                  {Object.entries(currentPlanFull.limits ?? {}).map(([k, v]) => (
                    <li key={k}>• {v == null || v === 0 ? "∞" : Number(v).toLocaleString("es-CL")} {LIMIT_LABELS[k] ?? k}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-400">Sin plan asignado — elige uno abajo o contacta a TuBot.</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <Button onClick={() => (data.plan ? void checkout(data.plan.code) : undefined)} disabled={busy || !data.plan}>
              <CreditCard size={14} /> Pagar ahora
            </Button>
            <span className="text-xs text-slate-400">
              vía <b>{PROVIDER_LABELS[data.paymentProvider] ?? data.paymentProvider}</b>
              {data.paymentMethod?.last4 && ` · ${data.paymentMethod.brand ?? "tarjeta"} •••• ${data.paymentMethod.last4}`}
            </span>
          </div>
        </div>

        {/* -------- Uso del período -------- */}
        <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
          <p className="text-sm font-medium text-slate-500">Uso del período</p>
          <ul className="mt-3 space-y-2.5">
            {Object.entries(data.usage).map(([key, u]) => {
              const unlimited = u.limit == null || u.limit === 0;
              const pct = unlimited ? null : Math.min(100, Math.round((u.used / u.limit!) * 100));
              return (
                <li key={key} className="text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-600">{USAGE_LABELS[key] ?? key}</span>
                    <span className="font-medium text-slate-500">
                      {u.used.toLocaleString("es-CL")} / {unlimited ? "∞" : u.limit!.toLocaleString("es-CL")}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={cn("h-full transition-all", pct === null ? "bg-slate-300" : pct < 70 ? "bg-emerald-400" : pct < 90 ? "bg-amber-400" : "bg-red-500")}
                      style={{ width: `${pct ?? (u.used > 0 ? 8 : 0)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* -------- Planes disponibles -------- */}
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">Planes disponibles</h2>
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => {
          const isCurrent = p.code === currentCode;
          const enterprise = !p.isPublic;
          return (
            <div key={p.code} className={cn("flex flex-col rounded-card border bg-white p-4 shadow-card", isCurrent ? "border-cyan-400 ring-1 ring-cyan-200" : "border-slate-200")}>
              <div className="flex items-center justify-between">
                <p className="font-semibold">{p.name}</p>
                {isCurrent && <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-medium text-cyan-700">Tu plan actual</span>}
              </div>
              <p className="mt-1 text-lg font-semibold text-slate-800">
                {enterprise && priceOf(p) === 0 ? "A medida" : money(priceOf(p), currency)}
                {!(enterprise && priceOf(p) === 0) && <span className="text-xs font-normal text-slate-400"> /{p.interval === "year" ? "año" : "mes"}</span>}
              </p>
              <ul className="mt-2 flex-1 space-y-0.5 text-[11px] text-slate-500">
                {Object.entries(p.limits ?? {}).slice(0, 5).map(([k, v]) => (
                  <li key={k}>• {v == null || v === 0 ? "∞" : Number(v).toLocaleString("es-CL")} {LIMIT_LABELS[k] ?? k}</li>
                ))}
              </ul>
              <div className="mt-3">
                {isCurrent ? (
                  <Button variant="secondary" className="w-full" disabled>Tu plan actual</Button>
                ) : enterprise && priceOf(p) === 0 ? (
                  <a href="mailto:contacto@tubot.cl?subject=Plan%20Enterprise" className="block rounded-lg border border-slate-300 py-2 text-center text-sm font-medium text-slate-600 hover:bg-slate-50">
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
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">Facturas</h2>
      {data.invoices.length === 0 ? (
        <p className="mt-2 rounded-card border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          Aún no tienes facturas — aparecerán aquí con tu primer pago.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] uppercase text-slate-400">
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
                  <tr key={inv.id} className="border-b border-slate-50">
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
          <p className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400">
            Descarga en PDF: disponible pronto — si necesitas una factura formal escríbenos a contacto@tubot.cl.
          </p>
        </div>
      )}

      {/* Confirmación de cambio de plan: qué gana/pierde */}
      <ConfirmDialog
        open={changing !== null}
        onClose={() => setChanging(null)}
        onConfirm={() => changing && void checkout(changing.code)}
        title={`¿Cambiar al plan ${changing?.name}?`}
        description={
          changing
            ? `Pasarás de ${data.plan?.name ?? "sin plan"} a ${changing.name} por ${money(priceOf(changing), currency)}/${changing.interval === "year" ? "año" : "mes"}. Nuevos límites: ${Object.entries(changing.limits ?? {})
                .map(([k, v]) => `${v == null || v === 0 ? "∞" : v} ${LIMIT_LABELS[k] ?? k}`)
                .join(" · ")}. Si bajas de plan y excedes un límite, no podrás crear más elementos de ese tipo (lo existente no se borra). El pago se procesa con ${PROVIDER_LABELS[data.paymentProvider] ?? data.paymentProvider}.`
            : ""
        }
        confirmLabel="Continuar al pago"
      />
    </div>
  );
}
