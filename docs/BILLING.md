# Planes y facturación

Módulo de suscripción y cobro de la plataforma hacia los tenants (SaaS billing). Implementado 2026-07-26.

> **Facturación tributaria (Chile) — FUERA DE ALCANCE por decisión (2026-08-04).**
> La emisión del documento tributario (boleta/factura del SII) se hace **fuera de la
> plataforma**, asociada al método de pago. El `invoice` interno
> (`CONV-AAAA-000000`) es **solo registro operativo** del cobro, **no** un DTE. No
> construir emisión de DTE en la plataforma ni listarlo como brecha de
> prelanzamiento.

## Modelo

- **`plans`**: catálogo global (code, name, `priceClp`, `priceUsd`, `interval`, `limits` JSON, `features` JSON, `isPublic`, `order`, `active`). Seed crea 4: `free`, `starter`, `pro`, `enterprise` (privado).
- **`subscriptions`**: por organización (planId, status TRIALING/ACTIVE/PAST_DUE/CANCELLED, periodStart/End).
- **`invoices`**: factura de la plataforma al tenant (number `CONV-AAAA-000000`, status DRAFT/OPEN/PAID/VOID/UNCOLLECTIBLE, currency, amountDue, lines JSON, dueAt, paidAt, provider, providerRef).
- **`payment_methods`**: método de pago del tenant — **sólo token/referencia del proveedor + metadatos no sensibles** (brand, last4). Nunca datos de tarjeta.
- **`usage_events`**: base del consumo (tokens IA, mensajes) para límites y overage.

Los `limits` del plan incluyen `aiTokensDaily`: el worker lo usa como tope diario de IA por tenant (0 = ilimitado); si no hay plan, cae al default de plataforma.

## Quién administra qué

- **Panel de plataforma** (`/admin`, super-admin con auth separada): organizaciones (suspender/activar), planes (precios/límites), asignar suscripción, emitir facturas y marcarlas pagadas, métricas (MRR, ingresos, costo IA).
- **Panel del tenant** (`/billing`): ver su plan, consumo vs. límites, elegir/upgradear plan (checkout), historial de facturas.

## Pasarela de pago (abstracción `PaymentProvider`)

Contrato: `createCheckout({organizationId, planCode, amount, currency, successUrl, cancelUrl}) → {id, url, provider}`.

- **MockPaymentProvider** (dev): no cobra; el frontend confirma vía `POST /billing/mock-confirm` que activa la suscripción y emite una factura pagada. Deshabilitado si hay `STRIPE_SECRET_KEY` en producción.
- **Stripe (recomendado, a implementar)**: `StripePaymentProvider.createCheckout` crea una Stripe Checkout Session (mode=subscription) y devuelve su `url`. El alta/renovación se confirma por **webhook** (`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`) firmado (`STRIPE_WEBHOOK_SECRET`) → activa la suscripción y sincroniza facturas. Nunca se tocan datos de tarjeta (los captura Stripe).

### Estado de las funciones

| Función | Estado |
|---|---|
| Planes CRUD + precios CLP/USD | Implementado |
| Suscripción por org + estado | Implementado |
| Facturas (emitir/pagar manual) | Implementado |
| Panel plataforma (orgs/planes/facturación/métricas) | Implementado |
| Panel tenant (plan/uso/checkout/facturas) | Implementado |
| Límite de IA por plan | Implementado |
| Checkout real + webhooks Stripe | **Pendiente de credenciales** (mock en dev) |
| Enforcement duro de límites (bloquear al exceder) | Implementado (IA + agentes/canales/flujos/usuarios → 403 al exceder) |
| Prorrateo, overage, notas de crédito, impuestos (IVA) | Pendiente |
| Cobro CLP local (Transbank/Webpay/Flow) | Pendiente (decisión de pasarela CL) |

## Variables de entorno

```
# Selección por MONEDA del tenant: CLP → Flow · resto (USD) → Stripe · vacías → mock.
STRIPE_SECRET_KEY=        # Stripe (USD/internacional)
STRIPE_WEBHOOK_SECRET=    # firma del webhook Stripe → POST /billing/webhooks/stripe
FLOW_API_KEY=            # Flow (Chile / CLP)
FLOW_SECRET_KEY=         # clave secreta (firma HMAC) de Flow → webhook POST /billing/webhooks/flow
FLOW_BASE_URL=          # https://www.flow.cl/api (prod) · default https://sandbox.flow.cl/api
PLATFORM_ADMIN_EMAIL=     # super-admin (seed)
PLATFORM_ADMIN_PASSWORD=  # super-admin (seed)
```

**Adaptadores** (`apps/api/src/billing/payment-provider.ts`): `StripePaymentProvider` (Checkout mode=subscription, precio recurrente inline, sin SDK), `FlowPaymentProvider` (payment/create firmado). Webhooks en `billing.controller.ts`: Stripe (verifica `Stripe-Signature`, evento `checkout.session.completed`) y Flow (consulta `getStatus` firmado, status=2 pagado). Ambos llaman a `activate()` → activan/renuevan la suscripción + emiten factura pagada. Rutas `/billing/webhooks/*` públicas (las valida su firma, no el JWT).

## Decisión de pasarela (pendiente de confirmar)

Alineado con la estrategia de Cláriva: **CLP para Chile, USD para el resto**. Para USD, Stripe es el más directo (requiere entidad/LLC o Merchant of Record como Paddle/Lemon Squeezy para evitarla). Para CLP local: Flow/Transbank Webpay. La abstracción `PaymentProvider` permite conectar cualquiera sin tocar el resto del sistema.
