"use client";

/**
 * Aviso global de cobro: cuenta regresiva de la PRUEBA de 7 días, período de
 * gracia (impago) o cuenta suspendida (impago o prueba vencida).
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, CreditCard, Rocket, Timer } from "lucide-react";
import { api } from "@/lib/api";

interface BillingState {
  billing?: {
    state: "ok" | "grace" | "suspended";
    graceEndsAt: string | null;
    trial?: { state: "active" | "disabled"; endsAt: string; daysLeft: number } | null;
  };
}

export function BillingBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<BillingState["billing"] | null>(null);

  useEffect(() => {
    void api<BillingState>("/billing/me")
      .then((r) => setState(r.billing ?? null))
      .catch(() => setState(null));
  }, []);

  // APAGADO TOTAL: si está SUSPENDIDA (impago o prueba vencida), la única ruta
  // accesible es la pantalla de pagos. El backend ya detuvo bot/flujos/IA.
  useEffect(() => {
    if (state?.state === "suspended" && pathname && !pathname.startsWith("/billing")) {
      router.replace("/billing");
    }
  }, [state, pathname, router]);

  if (!state) return null;

  const trialEnded = state.trial?.state === "disabled";

  // --- Suspendida (impago o prueba vencida): banner rojo + lockdown ---
  if (state.state === "suspended") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            {trialEnded ? (
              <>
                <b>Tu prueba de 7 días terminó.</b> El asistente quedó en pausa, pero NADA se borró: lo que montaste se
                guarda 7 días más. Activa un plan y sigue exactamente donde quedaste.
              </>
            ) : (
              <>
                <b>Cuenta suspendida por falta de pago.</b> El bot dejó de responder y los flujos están detenidos. Tus
                datos siguen intactos: paga para reactivar el servicio sin perder nada.
              </>
            )}
          </p>
        </div>
        <button
          onClick={() => router.push("/billing")}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
        >
          <CreditCard size={14} /> {trialEnded ? "Elegir mi plan" : "Pagar ahora"}
        </button>
      </div>
    );
  }

  // --- Gracia por impago: banner ámbar ---
  if (state.state === "grace") {
    const graceDate = state.graceEndsAt ? new Date(state.graceEndsAt).toLocaleDateString("es-CL") : null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            <b>Tu pago está vencido.</b> El servicio sigue activo{graceDate ? ` hasta el ${graceDate}` : ""}; regulariza
            antes de esa fecha para evitar la suspensión.
          </p>
        </div>
        <button
          onClick={() => router.push("/billing")}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
        >
          <CreditCard size={14} /> Pagar ahora
        </button>
      </div>
    );
  }

  // --- Prueba activa: cuenta regresiva (como el banner de etapas) + CTA a planes ---
  if (state.trial?.state === "active") {
    const d = state.trial.daysLeft;
    const urgent = d <= 2;
    const label = d <= 0 ? "Tu prueba termina HOY" : d === 1 ? "Te queda 1 día de prueba" : `Te quedan ${d} días de prueba`;
    return (
      <div
        className={
          urgent
            ? "flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            : "flex flex-wrap items-center justify-between gap-2 border-b border-line bg-brand-50/60 px-4 py-2 text-sm text-ink dark:bg-brand-500/10"
        }
      >
        <div className="flex items-center gap-2">
          <Timer size={15} className="shrink-0" />
          <p>
            <b>{label}.</b> Al terminar, el asistente se pausa hasta que actives un plan — lo que montes queda guardado.
          </p>
        </div>
        <button
          onClick={() => router.push("/billing")}
          className={
            urgent
              ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
              : "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          }
        >
          <Rocket size={14} /> Aumentar mi plan
        </button>
      </div>
    );
  }

  return null;
}
