/**
 * Contrato AGNÓSTICO del proveedor de suscripciones. Flow es el primero; Stripe queda
 * listo para encender y Lemon Squeezy existe para USD. La máquina de estados, la ventana
 * de 48 h, los reintentos, la suspensión, los avisos y la conciliación son lógica NUESTRA
 * y NO saben qué pasarela hay detrás — solo hablan por esta interfaz.
 *
 * Modelo de cobro elegido (portable a Stripe): tarjeta guardada + cobro por NUESTRO
 * calendario. En Flow = customer/register (guardar tarjeta) + customer/collect (cobrar);
 * en Stripe = SetupIntent + PaymentIntent off_session. No usamos el auto-cobro nativo de
 * la pasarela para conservar el control exacto de la ventana y los reintentos.
 */

/** Eventos INTERNOS normalizados: a esto se traduce CUALQUIER webhook de proveedor. */
export type NormalizedEvent =
  | { type: "payment_succeeded"; commerceOrder: string; amount: number; providerRef: string }
  | { type: "payment_failed"; commerceOrder: string; reason: string | null; providerRef: string }
  | { type: "payment_method_registered"; customerRef: string; token: string; brand: string | null; last4: string | null }
  | { type: "subscription_canceled"; customerRef: string }
  | { type: "ignored"; reason: string };

export interface CreateCustomerInput {
  organizationId: string;
  name: string;
  email: string;
}
export interface ChargeInput {
  customerRef: string;
  amount: number;
  currency: string;
  /** Identificador único del cobro en NUESTRO lado (idempotencia + conciliación). */
  commerceOrder: string;
  subject: string;
  /** URL donde el proveedor confirma el resultado (webhook). */
  urlConfirmation: string;
  urlReturn: string;
}
export interface ChargeResult {
  ok: boolean;
  providerRef: string | null;
  reason: string | null;
  /** true si el resultado es DEFINITIVO; false si queda pendiente y llegará por webhook. */
  settled: boolean;
}

export interface SubscriptionProvider {
  readonly kind: string; // "flow" | "stripe" | "lemonsqueezy" | "fake"
  /** Crea (o recupera) el cliente en el proveedor. */
  createCustomer(input: CreateCustomerInput): Promise<{ customerRef: string }>;
  /** Devuelve la URL hospedada donde el cliente registra su tarjeta (nunca la guardamos). */
  registerPaymentMethod(input: { customerRef: string; urlReturn: string }): Promise<{ url: string; token: string }>;
  /** Consulta el resultado del registro de tarjeta. */
  getPaymentMethodStatus(token: string): Promise<{ status: "registered" | "pending" | "failed"; brand: string | null; last4: string | null }>;
  /** Cobra el monto a la tarjeta guardada del cliente. */
  charge(input: ChargeInput): Promise<ChargeResult>;
  /** Reconsulta el estado de un cobro por su referencia (para reconciliar cobros pendientes / webhooks perdidos). */
  getChargeStatus(providerRef: string): Promise<{ settled: boolean; ok: boolean; reason: string | null }>;
  /** Cancela cualquier objeto de suscripción del proveedor (si aplica). No-op válido. */
  cancelSubscription(customerRef: string): Promise<void>;
  /** Verifica la firma del webhook entrante. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, secret: string): boolean;
  /** Traduce el webhook del proveedor a un evento interno normalizado. */
  normalizeWebhook(payload: unknown): Promise<NormalizedEvent> | NormalizedEvent;
}

/**
 * Adaptador FALSO para tests y desarrollo. Determinista y programable: se le indica si el
 * próximo cobro debe salir OK o fallar. Con esto se prueba toda la máquina de estados sin
 * tocar ninguna pasarela real (requisito de diseño).
 */
export class FakeSubscriptionProvider implements SubscriptionProvider {
  readonly kind = "fake";
  private nextChargeOk = true;
  private nextReason: string | null = null;
  private async_ = false; // si true, charge devuelve settled=false (simula Flow)
  charges: ChargeInput[] = [];

  /** Programa el resultado del PRÓXIMO charge. `async_` simula el flujo asíncrono de Flow. */
  scheduleCharge(ok: boolean, reason: string | null = null, async_ = false) {
    this.nextChargeOk = ok;
    this.nextReason = reason;
    this.async_ = async_;
  }

  async createCustomer(input: CreateCustomerInput) {
    return { customerRef: `fake_cus_${input.organizationId}` };
  }
  async registerPaymentMethod(input: { customerRef: string; urlReturn: string }) {
    return { url: `https://fake/pay/${input.customerRef}`, token: `fake_tok_${input.customerRef}` };
  }
  async getPaymentMethodStatus(_token: string) {
    return { status: "registered" as const, brand: "visa", last4: "4242" };
  }
  async charge(input: ChargeInput): Promise<ChargeResult> {
    this.charges.push(input);
    const ok = this.nextChargeOk;
    const reason = ok ? null : (this.nextReason ?? "card_declined");
    // settled=false simula el collect asíncrono de Flow (el resultado llega por reconciliación).
    return { ok: this.async_ ? true : ok, providerRef: `fake_ch_${this.charges.length}`, reason: this.async_ ? null : reason, settled: !this.async_ };
  }
  async getChargeStatus(_providerRef: string): Promise<{ settled: boolean; ok: boolean; reason: string | null }> {
    return { settled: true, ok: this.nextChargeOk, reason: this.nextChargeOk ? null : (this.nextReason ?? "card_declined") };
  }
  async cancelSubscription(_customerRef: string) {
    /* no-op */
  }
  verifyWebhook(_raw: Buffer, _headers: Record<string, string | undefined>, _secret: string) {
    return true;
  }
  normalizeWebhook(payload: unknown): NormalizedEvent {
    return (payload as NormalizedEvent) ?? { type: "ignored", reason: "empty" };
  }
}
