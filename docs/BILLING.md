# Planes y facturación

Módulo de suscripción y cobro de la plataforma hacia los tenants (SaaS billing). Implementado 2026-07-26.

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
| Enforcement duro de límites (bloquear al exceder) | Parcial (IA sí; agentes/canales/usuarios: sólo visualización) |
| Prorrateo, overage, notas de crédito, impuestos (IVA) | Pendiente |
| Cobro CLP local (Transbank/Webpay/Flow) | Pendiente (decisión de pasarela CL) |

## Variables de entorno

```
STRIPE_SECRET_KEY=        # vacío → pasarela mock
STRIPE_WEBHOOK_SECRET=    # firma de webhooks de Stripe
PLATFORM_ADMIN_EMAIL=     # super-admin (seed)
PLATFORM_ADMIN_PASSWORD=  # super-admin (seed)
```

## Decisión de pasarela (pendiente de confirmar)

Alineado con la estrategia de Cláriva: **CLP para Chile, USD para el resto**. Para USD, Stripe es el más directo (requiere entidad/LLC o Merchant of Record como Paddle/Lemon Squeezy para evitarla). Para CLP local: Flow/Transbank Webpay. La abstracción `PaymentProvider` permite conectar cualquiera sin tocar el resto del sistema.
