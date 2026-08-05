"use client";

/** Aviso global de cobro: período de gracia (impago) o cuenta suspendida. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CreditCard } from "lucide-react";
import { api } from "@/lib/api";

interface BillingState {
  billing?: { state: "ok" | "grace" | "suspended"; graceEndsAt: string | null };
}

export function BillingBanner() {
  const router = useRouter();
  const [state, setState] = useState<BillingState["billing"] | null>(null);

  useEffect(() => {
    void api<BillingState>("/billing/me")
      .then((r) => setState(r.billing ?? null))
      .catch(() => setState(null));
  }, []);

  if (!state || state.state === "ok") return null;

  const suspended = state.state === "suspended";
  const graceDate = state.graceEndsAt ? new Date(state.graceEndsAt).toLocaleDateString("es-CL") : null;

  return (
    <div
      className={
        suspended
          ? "flex flex-wrap items-center justify-between gap-2 border-b border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
          : "flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      }
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <p>
          {suspended ? (
            <>
              <b>Cuenta suspendida por falta de pago.</b> El bot dejó de responder y los flujos están detenidos. Tus
              datos siguen intactos: paga para reactivar el servicio sin perder nada.
            </>
          ) : (
            <>
              <b>Tu pago está vencido.</b> El servicio sigue activo{graceDate ? ` hasta el ${graceDate}` : ""}; regulariza
              antes de esa fecha para evitar la suspensión.
            </>
          )}
        </p>
      </div>
      <button
        onClick={() => router.push("/billing")}
        className={
          suspended
            ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
            : "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
        }
      >
        <CreditCard size={14} /> Pagar ahora
      </button>
    </div>
  );
}
