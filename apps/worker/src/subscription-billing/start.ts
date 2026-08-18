/**
 * Tick del cobro recurrente. Corre cada hora SOLO si RECURRING_BILLING_ENABLED=true
 * (apagado por defecto: se enciende tras aplicar la migración 20260818000000 y configurar
 * Flow). Al encenderlo, el dunning legacy de 7 días se apaga (guard en billing-dunning).
 */
import { getEnv } from "@conversia/config";
import { runBillingCycle } from "./engine";
import { createDbBillingPort } from "./db-port";
import { resolveSubscriptionProvider } from "./resolve-provider";

const HOUR = 3_600_000;

export function startSubscriptionBilling(): () => void {
  if (!getEnv().RECURRING_BILLING_ENABLED) {
    console.log("• Cobro recurrente APAGADO (RECURRING_BILLING_ENABLED != true).");
    return () => undefined;
  }
  const run = async () => {
    try {
      const env = getEnv();
      const port = createDbBillingPort();
      const urls = { confirmation: `${env.API_URL}/billing/webhooks/flow`, ret: `${env.WEB_URL}/billing` };
      const r = await runBillingCycle(port, resolveSubscriptionProvider, new Date(), urls);
      if (r.charged || r.suspended) console.log(`• Cobro recurrente: ${r.charged} cobros, ${r.suspended} suspensiones.`);
    } catch (err) {
      console.error("✖ subscription-billing tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, HOUR);
  interval.unref?.();
  return () => clearInterval(interval);
}
