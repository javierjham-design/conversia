/**
 * Adaptador de FLOW (Chile / CLP) para el cobro recurrente, sobre la interfaz agnóstica
 * SubscriptionProvider. Modelo: tarjeta guardada (customer/register) + cobro por nuestro
 * calendario (customer/collect). NO usamos el auto-cobro nativo de Flow para conservar el
 * control exacto de la ventana de 48 h y los reintentos.
 *
 * Endpoints usados (developers.flow.cl):
 *   customer/create           {apiKey,name,email,externalId,s} → { customerId }
 *   customer/register         {apiKey,customerId,url_return,s} → { url, token } (página hospedada)
 *   customer/getRegisterStatus{apiKey,token,s}                 → { status, creditCardType, last4digits }
 *   customer/collect          {apiKey,customerId,commerceOrder,subject,amount,urlConfirmation,urlReturn,s}
 *   payment/getStatus         {apiKey,token,s}                 → { status, commerceOrder, amount } (confirmación webhook)
 *
 * Webhook: Flow no firma con header; llama a urlConfirmation con un `token` y NOSOTROS
 * reconsultamos payment/getStatus (fuente de verdad firmada por nuestra propia clave).
 *
 * NOTA: los NOMBRES exactos de algunos campos de respuesta (status codes de collect,
 * last4) deben confirmarse contra el sandbox de Flow al encender; están marcados con TODO.
 */
import { createHmac } from "node:crypto";
import type { ChargeInput, ChargeResult, CreateCustomerInput, NormalizedEvent, SubscriptionProvider } from "./provider";

export interface FlowConfig {
  apiKey: string;
  secretKey: string;
  baseUrl: string; // https://www.flow.cl/api (prod) | https://sandbox.flow.cl/api
}

/** Firma Flow: HMAC-SHA256 de los params ordenados alfabéticamente (key+value concatenados). */
export function flowSign(params: Record<string, string>, secret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
  return createHmac("sha256", secret).update(toSign).digest("hex");
}

export class FlowSubscriptionProvider implements SubscriptionProvider {
  readonly kind = "flow";
  constructor(private cfg: FlowConfig) {}

  private async post(path: string, params: Record<string, string>): Promise<any> {
    const signed: Record<string, string> = { ...params, apiKey: this.cfg.apiKey };
    signed.s = flowSign(signed, this.cfg.secretKey);
    const res = await fetch(`${this.cfg.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(signed).toString(),
    });
    return res.json().catch(() => ({}));
  }
  private async get(path: string, params: Record<string, string>): Promise<any> {
    const signed: Record<string, string> = { ...params, apiKey: this.cfg.apiKey };
    signed.s = flowSign(signed, this.cfg.secretKey);
    const res = await fetch(`${this.cfg.baseUrl}/${path}?${new URLSearchParams(signed).toString()}`);
    return res.json().catch(() => ({}));
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ customerRef: string }> {
    const r = await this.post("customer/create", { name: input.name, email: input.email, externalId: input.organizationId });
    if (!r?.customerId) throw new Error(`Flow customer/create: ${r?.message ?? "sin customerId"}`);
    return { customerRef: String(r.customerId) };
  }

  async registerPaymentMethod(input: { customerRef: string; urlReturn: string }): Promise<{ url: string; token: string }> {
    const r = await this.post("customer/register", { customerId: input.customerRef, url_return: input.urlReturn });
    if (!r?.url || !r?.token) throw new Error(`Flow customer/register: ${r?.message ?? "sin url/token"}`);
    return { url: `${r.url}?token=${r.token}`, token: String(r.token) };
  }

  async getPaymentMethodStatus(token: string): Promise<{ status: "registered" | "pending" | "failed"; brand: string | null; last4: string | null }> {
    const r = await this.get("customer/getRegisterStatus", { token });
    // TODO(sandbox): confirmar el código de `status` (1=registrada) y nombres last4/brand.
    const registered = r?.status === 1 || r?.status === "1";
    return {
      status: registered ? "registered" : r?.status === 0 ? "pending" : "failed",
      brand: r?.creditCardType ?? null,
      last4: r?.last4digits ?? null,
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const r = await this.post("customer/collect", {
      customerId: input.customerRef,
      commerceOrder: input.commerceOrder,
      subject: input.subject,
      amount: String(Math.round(input.amount)),
      currency: input.currency,
      urlConfirmation: input.urlConfirmation,
      urlReturn: input.urlReturn,
    });
    // customer/collect devuelve un token de pago; el resultado DEFINITIVO llega por el
    // webhook (urlConfirmation) que reconsultamos con payment/getStatus. Por eso queda
    // "pendiente" (settled=false) salvo que Flow ya devuelva rechazo inmediato.
    if (r?.token) return { ok: true, providerRef: String(r.token), reason: null, settled: false };
    return { ok: false, providerRef: null, reason: r?.message ?? "collect_failed", settled: true };
  }

  async getChargeStatus(providerRef: string): Promise<{ settled: boolean; ok: boolean; reason: string | null }> {
    // providerRef = token de collect. status: 1 pendiente · 2 pagado · 3 rechazado · 4 anulado.
    const st = await this.get("payment/getStatus", { token: providerRef });
    if (st?.status === 2) return { settled: true, ok: true, reason: null };
    if (st?.status === 3 || st?.status === 4) return { settled: true, ok: false, reason: st?.status === 4 ? "anulado" : "rechazado" };
    return { settled: false, ok: false, reason: null };
  }

  async cancelSubscription(_customerRef: string): Promise<void> {
    // No usamos suscripciones nativas de Flow (cobramos por collect en nuestro calendario),
    // así que cancelar es dejar de programar cobros — se maneja en la máquina de estados.
  }

  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | undefined>, _secret: string): boolean {
    // Flow no firma el webhook con header: la verificación es RECONSULTAR getStatus con
    // nuestra clave (lo hace normalizeWebhook). Aceptamos el POST y validamos allí.
    return true;
  }

  async normalizeWebhook(payload: unknown): Promise<NormalizedEvent> {
    const token = (payload as { token?: string })?.token;
    if (!token) return { type: "ignored", reason: "sin token" };
    const st = await this.get("payment/getStatus", { token });
    // status: 1 pendiente · 2 pagado · 3 rechazado · 4 anulado
    if (st?.status === 2 && st?.commerceOrder) {
      return { type: "payment_succeeded", commerceOrder: String(st.commerceOrder), amount: Number(st.amount ?? 0), providerRef: token };
    }
    if ((st?.status === 3 || st?.status === 4) && st?.commerceOrder) {
      return { type: "payment_failed", commerceOrder: String(st.commerceOrder), reason: st?.status === 4 ? "anulado" : "rechazado", providerRef: token };
    }
    return { type: "ignored", reason: `status ${st?.status ?? "?"}` };
  }
}
