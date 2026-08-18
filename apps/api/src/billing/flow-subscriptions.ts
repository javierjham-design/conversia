/**
 * Cliente Flow de SUSCRIPCIONES para la API (alta y autogestión): crear cliente, registrar
 * tarjeta y cobrar (collect). La API solo INICIA; las transiciones de estado las aplica el
 * worker (engine + reconciliación) leyendo payment_attempts. Reutiliza la firma de Flow.
 * Mismos endpoints que el adaptador del worker (apps/worker/src/subscription-billing/flow-provider.ts).
 */
import { flowSign } from "./payment-provider";

export interface FlowConfig {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
}

async function post(cfg: FlowConfig, path: string, params: Record<string, string>): Promise<any> {
  const signed: Record<string, string> = { ...params, apiKey: cfg.apiKey };
  signed.s = flowSign(signed, cfg.secretKey);
  const res = await fetch(`${cfg.baseUrl}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signed).toString(),
  });
  return res.json().catch(() => ({}));
}
async function get(cfg: FlowConfig, path: string, params: Record<string, string>): Promise<any> {
  const signed: Record<string, string> = { ...params, apiKey: cfg.apiKey };
  signed.s = flowSign(signed, cfg.secretKey);
  const res = await fetch(`${cfg.baseUrl}/${path}?${new URLSearchParams(signed).toString()}`);
  return res.json().catch(() => ({}));
}

export async function flowCustomerCreate(cfg: FlowConfig, input: { name: string; email: string; organizationId: string }): Promise<string> {
  const r = await post(cfg, "customer/create", { name: input.name, email: input.email, externalId: input.organizationId });
  if (!r?.customerId) throw new Error(`Flow customer/create: ${r?.message ?? "sin customerId"}`);
  return String(r.customerId);
}

export async function flowRegisterCard(cfg: FlowConfig, input: { customerId: string; urlReturn: string }): Promise<{ url: string; token: string }> {
  const r = await post(cfg, "customer/register", { customerId: input.customerId, url_return: input.urlReturn });
  if (!r?.url || !r?.token) throw new Error(`Flow customer/register: ${r?.message ?? "sin url/token"}`);
  return { url: `${r.url}?token=${r.token}`, token: String(r.token) };
}

export async function flowRegisterStatus(cfg: FlowConfig, token: string): Promise<{ registered: boolean; brand: string | null; last4: string | null }> {
  const r = await get(cfg, "customer/getRegisterStatus", { token });
  const registered = r?.status === 1 || r?.status === "1";
  return { registered, brand: r?.creditCardType ?? null, last4: r?.last4digits ?? null };
}

/** Cobra a la tarjeta guardada. Devuelve el token del cobro (providerRef) para reconciliar. */
export async function flowCollect(cfg: FlowConfig, input: { customerId: string; commerceOrder: string; subject: string; amount: number; currency: string; urlConfirmation: string; urlReturn: string }): Promise<{ ok: boolean; token: string | null; reason: string | null }> {
  const r = await post(cfg, "customer/collect", {
    customerId: input.customerId,
    commerceOrder: input.commerceOrder,
    subject: input.subject,
    amount: String(Math.round(input.amount)),
    currency: input.currency,
    urlConfirmation: input.urlConfirmation,
    urlReturn: input.urlReturn,
  });
  if (r?.token) return { ok: true, token: String(r.token), reason: null };
  return { ok: false, token: null, reason: r?.message ?? "collect_failed" };
}
