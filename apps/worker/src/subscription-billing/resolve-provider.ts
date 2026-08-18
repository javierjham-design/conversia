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
  const dec = (k: string, fb: string) => (s[k] ? safeDecrypt(s[k]) : fb);
  const apiKey = dec("flow.apiKey", env.FLOW_API_KEY);
  const secretKey = dec("flow.secretKey", env.FLOW_SECRET_KEY);
  const baseUrl = s["flow.baseUrl"] || env.FLOW_BASE_URL;
  if (!apiKey || !secretKey || !baseUrl) return null;
  return { apiKey, secretKey, baseUrl };
}

function safeDecrypt(v: string): string {
  try {
    return decryptCredential(v);
  } catch {
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
  return new FakeSubscriptionProvider();
}
