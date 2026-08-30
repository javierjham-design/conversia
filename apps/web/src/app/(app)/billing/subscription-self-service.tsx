"use client";

/**
 * Autogestión de la SUSCRIPCIÓN RECURRENTE (Configuración → Plan y facturación):
 * activar cobro automático (registrar tarjeta en Flow), cancelar/reactivar, pagar
 * manualmente cuando corresponde, y ver el historial de cobros. La API inicia; el worker
 * aplica los resultados. Nunca se guardan datos de tarjeta.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, useToast } from "@/components/ui";

interface Attempt { id: string; amount: number; currency: string; kind: string; status: string; reason: string | null; createdAt: string }
interface History {
  subscription: { status: string; interval: string; periodEnd: string | null; nextChargeAt: string | null; cancelAtPeriodEnd: boolean } | null;
  attempts: Attempt[];
  invoices: Array<{ number: string; amountDue: number; currency: string; status: string; paidAt: string | null; createdAt: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  TRIALING: "En prueba", ACTIVE: "Activa", PAST_DUE: "Pago pendiente", SUSPENDED: "Suspendida", CANCELLED: "Cancelada",
};
const money = (n: number, c: string) => (c === "CLP" ? `$${n.toLocaleString("es-CL")}` : `US$${n.toFixed(2)}`);

export function SubscriptionSelfService({ planCode, interval }: { planCode: string | null; interval: "monthly" | "yearly" }) {
  const toast = useToast();
  const [h, setH] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [justPaid, setJustPaid] = useState(false);
  const confirmed = useRef(false);

  const load = useCallback(async () => {
    try {
      setH(await api<History>("/billing/subscription/history"));
    } catch {
      setH({ subscription: null, attempts: [], invoices: [] });
    }
  }, []);

  useEffect(() => {
    void load();
    // Retorno del registro de tarjeta de Flow (?card=1): confirma y cobra el 1.er período.
    if (confirmed.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("card") === "1") {
      confirmed.current = true;
      const token = sessionStorage.getItem("sub_card_token");
      window.history.replaceState(null, "", window.location.pathname);
      if (token) {
        void api<{ registered: boolean }>("/billing/subscription/confirm-card", { method: "POST", body: JSON.stringify({ token }) })
          .then((r) => {
            sessionStorage.removeItem("sub_card_token");
            if (r.registered) {
              setJustPaid(true);
              toast.push("Tarjeta registrada — procesando el primer cobro ✔", "ok");
            } else {
              toast.push("No se pudo registrar la tarjeta", "error");
            }
            void load();
          })
          .catch((e) => toast.push((e as Error).message, "error"));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function activate() {
    if (!planCode) { toast.push("Elige un plan primero", "error"); return; }
    setBusy(true);
    try {
      const r = await api<{ url: string; token: string }>("/billing/subscription/start", { method: "POST", body: JSON.stringify({ planCode, billingInterval: interval }) });
      sessionStorage.setItem("sub_card_token", r.token);
      window.location.href = r.url; // página segura de Flow para registrar la tarjeta
    } catch (e) {
      toast.push((e as Error).message, "error");
      setBusy(false);
    }
  }
  async function act(path: string, ok: string) {
    setBusy(true);
    try {
      await api(`/billing/subscription/${path}`, { method: "POST" });
      toast.push(ok, "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const sub = h?.subscription;
  const hasCard = sub && sub.status !== "TRIALING";
  const owes = sub && (sub.status === "PAST_DUE" || sub.status === "SUSPENDED");

  return (
    <div className="mt-6 rounded-card border border-line bg-panel p-5 shadow-card">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Suscripción automática</p>
        {sub && (
          <span className={`text-xs font-medium ${sub.status === "ACTIVE" ? "text-emerald-600" : sub.status === "SUSPENDED" ? "text-red-600" : "text-amber-600"}`}>
            ● {STATUS_LABEL[sub.status] ?? sub.status}
          </span>
        )}
      </div>

      {justPaid && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
          <span className="text-base leading-none">🎉</span>
          <p>
            <b>¡Listo, tu plan quedó activo!</b> Registramos tu tarjeta y el cobro se renovará solo en cada fecha — no
            tienes que volver a pagar a mano. Puedes cancelar cuando quieras desde aquí.
          </p>
        </div>
      )}

      {!hasCard ? (
        <>
          <p className="mt-2 text-xs text-ink-muted">
            Activa el cobro automático para no tener que pagar todos los meses. Registras tu tarjeta una vez en la página
            segura de Flow (nunca guardamos los datos), y se cobra el {interval === "yearly" ? "año" : "mes"} de forma
            automática en cada fecha de renovación. Puedes cancelar cuando quieras desde aquí.
          </p>
          <Button className="mt-3" disabled={busy || !planCode} onClick={() => void activate()}>
            {busy ? "Redirigiendo…" : "Activar cobro automático (registrar tarjeta)"}
          </Button>
        </>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-muted">
            {sub!.cancelAtPeriodEnd
              ? <>Cancelada: tienes servicio hasta el <b>{sub!.periodEnd ? new Date(sub!.periodEnd).toLocaleDateString("es-CL") : "—"}</b> y no se cobrará de nuevo.</>
              : sub!.nextChargeAt
                ? <>Próximo cobro automático: <b>{new Date(sub!.nextChargeAt).toLocaleDateString("es-CL")}</b> ({interval === "yearly" ? "anual" : "mensual"}).</>
                : "Cobro automático activo."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {owes && <Button disabled={busy} onClick={() => void act("manual-pay", "Iniciando el pago…")}>Pagar ahora</Button>}
            <Button disabled={busy} onClick={() => void activate()}>Cambiar tarjeta</Button>
            {sub!.cancelAtPeriodEnd
              ? <button disabled={busy} onClick={() => void act("reactivate", "Suscripción reactivada")} className="rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-app disabled:opacity-50">Reactivar</button>
              : <button disabled={busy} onClick={() => { if (confirm("Al cancelar seguirás con servicio hasta el fin del período pagado y no se cobrará de nuevo. ¿Continuar?")) void act("cancel", "Suscripción cancelada"); }} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">Cancelar suscripción</button>}
          </div>
        </>
      )}

      {/* Historial de cobros */}
      {h && h.attempts.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-ink-muted">Historial de cobros</p>
          <div className="mt-1 overflow-hidden rounded-lg border border-line text-xs">
            {h.attempts.slice(0, 8).map((a) => (
              <div key={a.id} className="flex items-center justify-between border-b border-line px-3 py-1.5 last:border-0">
                <span className="text-ink-muted">{new Date(a.createdAt).toLocaleDateString("es-CL")} · {a.kind === "manual" ? "manual" : a.kind === "retry" ? "reintento" : "automático"}</span>
                <span className="flex items-center gap-2">
                  <span>{money(a.amount, a.currency)}</span>
                  <span className={a.status === "succeeded" ? "text-emerald-600" : a.status === "failed" ? "text-red-600" : "text-amber-600"}>
                    {a.status === "succeeded" ? "pagado" : a.status === "failed" ? "rechazado" : "pendiente"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
