import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@conversia/config";

/**
 * Abstracción de pasarela de pago (patrón provider). Selección por moneda:
 * CLP → Flow (Chile), resto → Stripe (USD internacional). Mock en dev si no hay
 * credenciales. NUNCA se guardan datos de tarjeta: sólo el token/referencia.
 * Contrato y decisiones en docs/BILLING.md.
 */
export interface CheckoutSession {
  id: string;
  url: string;
  provider: string;
}

export interface CheckoutInput {
  organizationId: string;
  planCode: string;
  amount: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  email?: string;
  interval?: string; // monthly | yearly
  variantId?: string; // Lemon Squeezy: id de variante del plan
}

export interface PaymentProvider {
  readonly kind: string;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
}

/** Mock: no cobra; devuelve una URL interna que marca la factura como pagada. */
export class MockPaymentProvider implements PaymentProvider {
  readonly kind = "mock";
  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const id = `mock_cs_${Date.now()}`;
    return { id, url: `${input.successUrl}?mock_session=${id}`, provider: "mock" };
  }
}

/** Monedas sin decimales (el monto va tal cual, no en centavos). */
const ZERO_DECIMAL = new Set(["CLP", "JPY", "KRW", "VND", "XAF", "XOF", "CLF"]);

/** Stripe Checkout (suscripción) vía HTTP directo — sin SDK. USD/internacional. */
export class StripePaymentProvider implements PaymentProvider {
  readonly kind = "stripe";
  constructor(private secretKey: string) {}

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const cur = input.currency.toLowerCase();
    const minor = ZERO_DECIMAL.has(input.currency.toUpperCase())
      ? Math.round(input.amount)
      : Math.round(input.amount * 100);
    const interval = input.interval === "yearly" ? "year" : "month";
    const p = new URLSearchParams();
    p.set("mode", "subscription");
    p.set("success_url", `${input.successUrl}?paid=1`);
    p.set("cancel_url", input.cancelUrl);
    p.set("client_reference_id", input.organizationId);
    p.set("metadata[organizationId]", input.organizationId);
    p.set("metadata[planCode]", input.planCode);
    // Monto esperado (unidad menor) para que el webhook valide lo pagado (S-4).
    p.set("metadata[expectedAmount]", String(minor));
    p.set("subscription_data[metadata][organizationId]", input.organizationId);
    p.set("subscription_data[metadata][planCode]", input.planCode);
    if (input.email) p.set("customer_email", input.email);
    p.set("line_items[0][quantity]", "1");
    p.set("line_items[0][price_data][currency]", cur);
    p.set("line_items[0][price_data][unit_amount]", String(minor));
    p.set("line_items[0][price_data][recurring][interval]", interval);
    p.set("line_items[0][price_data][product_data][name]", `TuBot — Plan ${input.planCode}`);

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: p.toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.url) throw new Error(`Stripe checkout: ${json?.error?.message ?? res.status}`);
    return { id: json.id, url: json.url, provider: "stripe" };
  }
}

/**
 * Lemon Squeezy (Merchant of Record). Crea un checkout hospedado por API para la
 * variante del plan. LS cobra, factura, paga impuestos y te paga vía su Stripe
 * Express. El organizationId/planCode viajan en checkout_data.custom y vuelven en
 * el webhook (meta.custom_data). Secretos SOLO por entorno.
 */
export class LemonSqueezyPaymentProvider implements PaymentProvider {
  readonly kind = "lemonsqueezy";
  constructor(
    private apiKey: string,
    private storeId: string,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    if (!input.variantId) throw new Error("Este plan no tiene Variant ID de Lemon Squeezy configurado (edítalo en Planes).");
    const body = {
      data: {
        type: "checkouts",
        attributes: {
          checkout_data: {
            email: input.email,
            custom: { organization_id: input.organizationId, plan_code: input.planCode },
          },
          product_options: { redirect_url: `${input.successUrl}?paid=1` },
        },
        relationships: {
          store: { data: { type: "stores", id: String(this.storeId) } },
          variant: { data: { type: "variants", id: String(input.variantId) } },
        },
      },
    };
    const res = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/vnd.api+json",
        accept: "application/vnd.api+json",
      },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    const url = json?.data?.attributes?.url;
    if (!res.ok || !url) throw new Error(`Lemon Squeezy checkout: ${json?.errors?.[0]?.detail ?? res.status}`);
    return { id: json.data.id, url, provider: "lemonsqueezy" };
  }
}

/** Verifica el webhook de Lemon Squeezy: HMAC-SHA256(rawBody) hex == X-Signature. */
export function verifyLemonSqueezySignature(rawBody: Buffer, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return sigHeader.length === expected.length && timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Firma de Flow: HMAC-SHA256 de los params ordenados alfabéticamente (key+value). */
export function flowSign(params: Record<string, string>, secret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
  return createHmac("sha256", secret).update(toSign).digest("hex");
}

/** Flow (Chile) vía HTTP directo. CLP. */
export class FlowPaymentProvider implements PaymentProvider {
  readonly kind = "flow";
  constructor(
    private apiKey: string,
    private secretKey: string,
    private baseUrl: string,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const env = getEnv();
    const params: Record<string, string> = {
      apiKey: this.apiKey,
      commerceOrder: `tubot-${input.organizationId.slice(0, 8)}-${Date.now()}`,
      subject: `TuBot — Plan ${input.planCode}`,
      currency: input.currency,
      amount: String(Math.round(input.amount)),
      email: input.email || "facturacion@tubot.cl",
      urlConfirmation: `${env.API_URL}/billing/webhooks/flow`,
      urlReturn: `${input.successUrl}?paid=1`,
      // expectedAmount: el webhook compara lo reportado por Flow contra esto (S-4).
      optional: JSON.stringify({ organizationId: input.organizationId, planCode: input.planCode, expectedAmount: Math.round(input.amount) }),
    };
    params.s = flowSign(params, this.secretKey);
    const res = await fetch(`${this.baseUrl}/payment/create`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!json?.url || !json?.token) throw new Error(`Flow create: ${json?.message ?? res.status}`);
    return { id: json.token, url: `${json.url}?token=${json.token}`, provider: "flow" };
  }
}

/** Verifica la firma del webhook de Stripe (Stripe-Signature: t=…,v1=…). */
export function verifyStripeSignature(rawBody: Buffer, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader) return false;
  const parts: Record<string, string> = {};
  for (const kv of sigHeader.split(",")) {
    const idx = kv.indexOf("=");
    if (idx > 0) parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex");
  try {
    return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Credenciales efectivas de las pasarelas (BD cifrada, con fallback a env). */
export interface PaymentSettings {
  flow?: { apiKey: string; secretKey: string; baseUrl: string };
  lemonSqueezy?: { apiKey: string; storeId: string; webhookSecret: string };
}

/**
 * Selección de pasarela: si el tenant tiene un proveedor asignado (`preferred`),
 * se usa ese; si no, por moneda (CLP → Flow, resto → Lemon Squeezy). Cae a Mock
 * si no hay credenciales. Las credenciales vienen del gestor (BD) o de env.
 */
export function createPaymentProvider(settings: PaymentSettings, currency = "CLP", preferred?: string): PaymentProvider {
  const isClp = currency.toUpperCase() === "CLP";
  const flow = () => new FlowPaymentProvider(settings.flow!.apiKey, settings.flow!.secretKey, settings.flow!.baseUrl);
  const ls = () => new LemonSqueezyPaymentProvider(settings.lemonSqueezy!.apiKey, settings.lemonSqueezy!.storeId);
  // 1) Preferencia explícita del tenant.
  if (preferred === "flow" && settings.flow) return flow();
  if (preferred === "lemonsqueezy" && settings.lemonSqueezy) return ls();
  // 2) Por moneda.
  if (isClp && settings.flow) return flow();
  if (!isClp && settings.lemonSqueezy) return ls();
  // 3) Lo que haya configurado.
  if (settings.flow) return flow();
  if (settings.lemonSqueezy) return ls();
  return new MockPaymentProvider();
}
