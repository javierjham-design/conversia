/**
 * Adaptador de STRIPE para el cobro recurrente — ESQUELETO listo para encender.
 *
 * Está escrito hasta donde se puede sin credenciales. Para activarlo: configurar
 * STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET, completar los TODO de las llamadas HTTP y
 * registrar el webhook en el dashboard de Stripe. NO hay que tocar el resto del módulo:
 * la máquina de estados, la ventana de 48 h, los reintentos, los avisos y la conciliación
 * ya hablan por la interfaz SubscriptionProvider.
 *
 * Modelo (equivalente al de Flow, mismo contrato):
 *   createCustomer          → POST /v1/customers                         (Customer)
 *   registerPaymentMethod   → POST /v1/checkout/sessions (mode=setup)    → url hospedada (SetupIntent)
 *   getPaymentMethodStatus  → recuperar el SetupIntent / PaymentMethod   (brand, last4)
 *   charge                  → POST /v1/payment_intents (off_session,     cobro a la tarjeta guardada)
 *                              confirm=true, customer, payment_method)
 *   cancelSubscription      → no-op (cobramos por PaymentIntent en nuestro calendario)
 *
 * Mapeo de webhooks de Stripe → eventos internos normalizados:
 *   payment_intent.succeeded            → { type: "payment_succeeded", commerceOrder=metadata.commerceOrder, amount, providerRef=pi.id }
 *   payment_intent.payment_failed       → { type: "payment_failed",    commerceOrder=metadata.commerceOrder, reason=last_payment_error, providerRef=pi.id }
 *   setup_intent.succeeded              → { type: "payment_method_registered", customerRef=si.customer, token=si.id, brand, last4 }
 *   customer.subscription.deleted       → { type: "subscription_canceled", customerRef=sub.customer }
 *   (otros)                             → { type: "ignored" }
 * Firma del webhook: verifyStripeSignature(rawBody, "Stripe-Signature", STRIPE_WEBHOOK_SECRET)
 * (ya existe en apps/api/src/billing/payment-provider.ts; reutilizar).
 */
import type { ChargeInput, ChargeResult, CreateCustomerInput, NormalizedEvent, SubscriptionProvider } from "./provider";

export class StripeSubscriptionProvider implements SubscriptionProvider {
  readonly kind = "stripe";
  constructor(private _secretKey: string) {}

  async createCustomer(_input: CreateCustomerInput): Promise<{ customerRef: string }> {
    // TODO(stripe): POST https://api.stripe.com/v1/customers (name, email, metadata[organizationId]) → { id }
    throw new Error("Stripe subscription provider no configurado (completar TODO + credenciales).");
  }
  async registerPaymentMethod(_input: { customerRef: string; urlReturn: string }): Promise<{ url: string; token: string }> {
    // TODO(stripe): POST /v1/checkout/sessions mode=setup, customer, success_url → { url, id }
    throw new Error("Stripe: registerPaymentMethod pendiente.");
  }
  async getPaymentMethodStatus(_token: string): Promise<{ status: "registered" | "pending" | "failed"; brand: string | null; last4: string | null }> {
    // TODO(stripe): recuperar SetupIntent → payment_method → { card.brand, card.last4 }
    return { status: "pending", brand: null, last4: null };
  }
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    // TODO(stripe): POST /v1/payment_intents { amount, currency, customer, payment_method,
    // off_session:true, confirm:true, metadata[commerceOrder] }. Resultado por webhook.
    throw new Error("Stripe: charge pendiente.");
  }
  async cancelSubscription(_customerRef: string): Promise<void> {
    /* no-op: cobramos por PaymentIntent en nuestro calendario */
  }
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | undefined>, _secret: string): boolean {
    // TODO(stripe): reutilizar verifyStripeSignature(rawBody, headers["stripe-signature"], secret).
    return false;
  }
  normalizeWebhook(_payload: unknown): NormalizedEvent {
    // TODO(stripe): mapear los eventos según el bloque de documentación de arriba.
    return { type: "ignored", reason: "stripe no implementado" };
  }
}
