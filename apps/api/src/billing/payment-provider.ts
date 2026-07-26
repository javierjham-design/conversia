/**
 * Abstracción de pasarela de pago (patrón provider, como agenda/canales).
 * MockPaymentProvider permite desarrollar el ciclo de suscripción/factura sin
 * credenciales. El adaptador real recomendado es Stripe (Checkout + webhooks);
 * su contrato se documenta en docs/BILLING.md. NUNCA se guardan datos de
 * tarjeta: sólo el token/referencia del proveedor.
 */
export interface CheckoutSession {
  id: string;
  url: string;
  provider: string;
}

export interface PaymentProvider {
  readonly kind: string;
  /** Crea una sesión de checkout para que el tenant pague/cambie de plan. */
  createCheckout(input: {
    organizationId: string;
    planCode: string;
    amount: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession>;
}

/** Mock: no cobra; devuelve una URL interna que marca la factura como pagada. */
export class MockPaymentProvider implements PaymentProvider {
  readonly kind = "mock";
  async createCheckout(input: {
    organizationId: string;
    planCode: string;
    amount: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession> {
    const id = `mock_cs_${Date.now()}`;
    // La URL de éxito la resuelve el frontend/endpoint mock (no hay cobro real).
    return { id, url: `${input.successUrl}?mock_session=${id}`, provider: "mock" };
  }
}

export function createPaymentProvider(): PaymentProvider {
  // Cuando exista STRIPE_SECRET_KEY se instancia StripePaymentProvider (doc).
  return new MockPaymentProvider();
}
