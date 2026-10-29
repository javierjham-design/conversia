import { getEnv } from "@conversia/config";
import { reconciliarRecargas } from "./recharge-reconcile";
import { createDbRechargeReconcilePort } from "./recharge-reconcile-port";
import { resolveSubscriptionProvider } from "./subscription-billing/resolve-provider";

/** Cada cuánto se cierran las recargas a medias (por defecto 10 min). */
export const TICK_MS = 10 * 60 * 1000;

/**
 * Arranca el pase de reconciliación de recargas.
 *
 * Va APARTE del tick de cobro recurrente, y no es un detalle de orden: ese tick está gateado
 * por `RECURRING_BILLING_ENABLED`, y un cobro de recarga que ya salió a la tarjeta del
 * cliente tiene que cerrarse aunque después se apague el cobro automático. Si viviera dentro
 * del tick gateado, apagar la bandera dejaría pagos cobrados sin créditos y sin alerta — que
 * es justo el agujero que esto viene a tapar. Es el mismo criterio que la reconciliación de
 * los cobros de IA.
 */
export function startRechargeReconcile(): () => void {
  const run = async () => {
    try {
      const r = await reconciliarRecargas(createDbRechargeReconcilePort(), resolveSubscriptionProvider, new Date());
      // Se loguea solo cuando hubo algo que cerrar: en el día normal no hay recargas a
      // medias y una línea por tick sería ruido. Lo que sí no puede faltar nunca es el
      // detalle cuando aparece plata involucrada.
      if (r.acreditadas || r.rechazadas || r.pagadasSinAcreditar || r.sinResolver || r.errores) {
        console.log(
          `• Recargas reconciliadas: ${r.acreditadas} acreditadas, ${r.rechazadas} rechazadas` +
            `${r.pagadasSinAcreditar ? `, ${r.pagadasSinAcreditar} PAGADAS SIN ACREDITAR` : ""}` +
            `${r.sinResolver ? `, ${r.sinResolver} sin resolver` : ""}` +
            `${r.errores ? `, ${r.errores} con error` : ""} (de ${r.revisadas} pendientes).`,
        );
      }
    } catch (err) {
      console.error("✖ reconciliación de recargas:", (err as Error).message);
    }
  };
  void run();
  const cada = Number(getEnv().RECHARGE_RECONCILE_MS) || TICK_MS;
  const interval = setInterval(run, cada);
  interval.unref?.();
  return () => clearInterval(interval);
}
