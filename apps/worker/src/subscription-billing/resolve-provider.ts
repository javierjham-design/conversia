/**
 * Resuelve el SubscriptionProvider para un tenant, respetando la selección por tenant
 * (organization.settings.paymentProvider) y por moneda que ya existe en el Super Admin.
 * Lee las credenciales CIFRADAS de `platform_settings` (mismo formato AES-256-GCM que la
 * API), con fallback a variables de entorno. Si no hay credenciales de Flow, cae al
 * adaptador FALSO (dev) para no romper.
 */
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { decryptCredential } from "../credentials";
import { opsAlert } from "../ops-alert.js";
import { FlowSubscriptionProvider } from "./flow-provider";
import { FakeSubscriptionProvider } from "./provider";
import type { SubscriptionProvider } from "./provider";

async function platformSettings(): Promise<Record<string, string>> {
  try {
    const rows = await getAdminPrisma().platformSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

function flowConfigFrom(s: Record<string, string>): { apiKey: string; secretKey: string; baseUrl: string } | null {
  const env = getEnv();
  const dec = (k: string, fb: string) => (s[k] ? safeDecrypt(k, s[k]) : fb);
  const apiKey = dec("flow.apiKey", env.FLOW_API_KEY);
  const secretKey = dec("flow.secretKey", env.FLOW_SECRET_KEY);
  const baseUrl = s["flow.baseUrl"] || env.FLOW_BASE_URL;
  if (!apiKey || !secretKey || !baseUrl) return null;
  return { apiKey, secretKey, baseUrl };
}

/**
 * §9.1 — un fallo al descifrar NO puede pasar en silencio: devolver "" hacía que el
 * sistema creyera que "no hay credenciales" y cayera al proveedor FALSO. Se registra
 * ruidosamente (sin exponer el valor).
 */
function safeDecrypt(key: string, v: string): string {
  try {
    return decryptCredential(v);
  } catch (err) {
    console.error(
      `✖ No se pudo descifrar la credencial de pago "${key}" (${(err as Error).message}). ` +
        "Se tratará como ausente: revisá CREDENTIALS_ENCRYPTION_KEY.",
    );
    return "";
  }
}

export async function resolveSubscriptionProvider(orgId: string): Promise<SubscriptionProvider> {
  const s = await platformSettings();
  const org = await getAdminPrisma().organization.findUnique({ where: { id: orgId }, select: { settings: true, currency: true } });
  const preferred = ((org?.settings as Record<string, unknown> | null)?.paymentProvider as string | undefined) ?? undefined;
  const isClp = (org?.currency ?? "CLP").toUpperCase() === "CLP";
  const flow = flowConfigFrom(s);

  // Preferencia explícita del tenant o por moneda (CLP → Flow). Stripe/LS: pendientes de
  // encender en este módulo recurrente (ver stripe-provider.ts).
  if ((preferred === "flow" || (!preferred && isClp)) && flow) {
    return new FlowSubscriptionProvider(flow);
  }
  if (flow) return new FlowSubscriptionProvider(flow);

  // §9.1 — SIN credenciales de Flow. El adaptador FALSO da todos los cobros por exitosos
  // SIN cobrar un peso: en producción eso renueva suscripciones y recarga bolsas gratis, en
  // silencio y sin que nadie se entere. Solo se permite fuera de producción y con el
  // interruptor explícito; en producción se LANZA para que el tick se omita y quede alerta.
  const fakeAllowed =
    getEnv().NODE_ENV !== "production" && process.env.ALLOW_FAKE_BILLING_PROVIDER === "true";
  if (fakeAllowed) {
    console.warn("⚠ Cobro recurrente con el proveedor FALSO (ALLOW_FAKE_BILLING_PROVIDER). Nunca en producción.");
    return new FakeSubscriptionProvider();
  }

  const detalle =
    "Cobro recurrente DETENIDO: no hay credenciales de Flow (ni en platform_settings ni en el entorno). " +
    "No se usa el proveedor falso para no dar por cobrado lo que no se cobró.";
  console.error(`✖ ${detalle}`);
  await opsAlert({
    summary: "Cobro recurrente sin credenciales de Flow",
    description: detalle,
    severity: "critical",
  }).catch(() => undefined);
  throw new Error(detalle);
}
