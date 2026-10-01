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

## Cobro RECURRENTE de suscripciones (2026-08-18, en construcción)

Programa para pasar del pago único manual a **suscripciones recurrentes automáticas**
(mensuales y anuales) con cobro en la fecha de facturación, ventana de gracia de 48 h,
avisos multicanal y apagado total por impago. Diseño **agnóstico de pasarela**: Flow
primero, Stripe listo para encender, Lemon Squeezy para USD.

### Contrato del proveedor (`apps/worker/src/subscription-billing/provider.ts`)

`SubscriptionProvider` — la lógica NUESTRA (máquina de estados, 48 h, reintentos,
suspensión, avisos, conciliación) NO sabe qué pasarela hay detrás; solo habla por aquí:

| Método | Qué hace | Flow | Stripe |
|---|---|---|---|
| `createCustomer` | crea/recupera cliente | `customer/create` | `POST /v1/customers` |
| `registerPaymentMethod` | URL hospedada para guardar tarjeta | `customer/register` | Checkout `mode=setup` |
| `getPaymentMethodStatus` | resultado del registro | `customer/getRegisterStatus` | recuperar SetupIntent |
| `charge` | cobra a la tarjeta guardada | `customer/collect` | PaymentIntent `off_session` |
| `cancelSubscription` | no-op (cobramos por nuestro calendario) | — | — |
| `verifyWebhook` + `normalizeWebhook` | traduce el webhook a un **evento interno** | reconsulta `payment/getStatus` | `Stripe-Signature` + mapa de eventos |

**Modelo de cobro** (portable): tarjeta guardada + cobro por NUESTRO calendario (no el
auto-cobro nativo de la pasarela), para conservar el control exacto de la ventana y los
reintentos. Eventos internos normalizados: `payment_succeeded`, `payment_failed`,
`payment_method_registered`, `subscription_canceled`, `ignored`.

### Máquina de estados (`state-machine.ts`, PURA + 21 tests con adaptador falso)

```
ACTIVE ──(fecha de cobro)──► charge
  éxito → renueva período (+1 mes / +12 meses), acredita bolsa, sigue ACTIVE
  rechazo → PAST_DUE (abre ventana de 48 h)

PAST_DUE (48 h EXACTAS desde el 1.er fallo; la plataforma SIGUE operativa)
  reintentos automáticos: fallo (0 h) · +12 h · +36 h   (customer/collect)
  pago (auto o MANUAL) en cualquier momento → ACTIVE sin pérdida (preserva el ancla)
  se cumplen 48 h sin pago → SUSPENDED

SUSPENDED (apagado total)
  pago en cualquier momento → reactivación INMEDIATA (período fresco desde ahora)

CANCELED (a solicitud)
  sigue ACTIVE hasta el fin del período pagado → ahí SUSPENDED (nunca cobra un período nuevo)
```

Tiempos por **duración exacta** (inmune a huso/horario de verano); las fechas se
**muestran** en zona horaria de Chile (America/Santiago). Reintentos y suspensión con
registro en `payment_attempts` (idempotente por `commerce_order`) y `audit_logs`.

### Datos (migración `20260818000000_recurring_billing`)

- `subscriptions`: + `interval`, `provider_customer_ref`, `provider_subscription_ref`,
  `payment_method_id`, `next_charge_at`, `past_due_since`, `retries_done`,
  `cancel_at_period_end`; enum `SubscriptionStatus` + `SUSPENDED`.
- `payment_attempts` (nueva): registro de cada cobro (auto/retry/manual), único por
  `commerce_order`.
- `payment_methods` (ya existía): solo token/ref del proveedor + brand/last4.

### Qué debe configurar el dueño en su cuenta de FLOW

1. Cuenta Flow con **suscripciones/clientes habilitados** (customer + collect).
2. `FLOW_API_KEY` + `FLOW_SECRET_KEY` (los mismos del pago único ya cargados en
   `platform_settings`).
3. `FLOW_BASE_URL`: `https://sandbox.flow.cl/api` para probar, `https://www.flow.cl/api`
   en producción.
4. La URL de confirmación (`urlConfirmation`) se envía por transacción — Flow no requiere
   configurar webhook en su panel.

### Qué falta para encender STRIPE

Completar `stripe-provider.ts` (los `TODO`: customers, checkout mode=setup, PaymentIntent
off_session, mapa de webhooks), cargar `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`, y
registrar el webhook en el dashboard. **No** hay que tocar el resto del módulo.

### Selección de pasarela

Se respeta la existente: por tenant (`organization.settings.paymentProvider`) y por
moneda (CLP → Flow, USD → Lemon Squeezy/Stripe). La máquina de estados es la misma para
todas.

## Tarifa de mensajes de servicio (octubre 2026)

Desde el **2026-10-01** Meta cobra los mensajes de **servicio** de WhatsApp (respuestas
libres dentro de la ventana de 24 h), que antes eran gratis. Hay **1.000 gratis/mes por
número**; sobre ese umbral se cobra (~USD 0,0200 por mensaje en Chile). La tarifa NO se
hardcodea: vive en un **calendario con fecha de vigencia** editable sin deploy.

### Dónde vive y formato

- Key de `platform_settings`: **`whatsappRateSchedule`** (SEPARADA de `whatsappRates`
  a propósito: el zod del `PATCH /platform/cost-settings` hace strip de campos
  desconocidos y el merge de la calculadora del admin pisaría los tramos si vivieran
  dentro de `whatsappRates`).
- La lee `getWhatsappRateSchedule()` (`apps/worker/src/cost-settings.ts`, cache 60 s;
  JSON inválido o ausente → `{}` = "sin schedule").
- La consume `computeWhatsappCostUsd(category, countryIso, overrides?, { at, schedule })`
  (`packages/agents/src/pricing.ts`). Precedencia: (1) tramo vigente del schedule;
  (2) override plano `whatsappRates`; (3) tabla base. Sin `at`/`schedule` el
  comportamiento es idéntico al histórico.
- **Vigencia por fecha:** rige el tramo cuyo `effectiveFrom` (UTC, límite **INCLUSIVE**)
  sea el mayor que no supere la fecha evaluada. A las `2026-10-01T00:00:00Z` exactas ya
  rige el tramo de octubre.

JSON de ejemplo (Chile, servicio USD 0,0200 desde el 1-oct-2026):

```json
{
  "CL": {
    "service": [
      { "effectiveFrom": "2026-10-01T00:00:00Z", "rateUsd": 0.0200 }
    ]
  }
}
```

### Cómo se cambia sin deploy

- **SQL:** `INSERT INTO platform_settings (key, value) VALUES ('whatsappRateSchedule',
  '<json>') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`
- **API:** key propia en `platform_settings` (NO mezclar con `whatsappRates`).
- Para subir la tarifa en el futuro: agregar un tramo nuevo con `effectiveFrom` mayor;
  el histórico se conserva y la vigencia la resuelve la fecha del mensaje.

> **La siembra en producción es un paso operativo del dueño** (no la hace el código).
> E1 solo construye el cimiento; la medición/cobro real entra en E2+.

### Checklist de verificación del rate card — HACER AHORA (no "cuando Meta publique")

El cobro **ya rige** (2026-10-01). Verificar contra datos reales **de inmediato**, porque
cada día sin schedule sembrado es costo invisible:

1. **Precio CL definitivo:** confirmar el valor exacto de servicio en Chile contra el
   rate card vigente de Meta (el ejemplo usa USD 0,0200).
2. **Etiqueta de la categoría en el webhook de status real:** capturar un webhook de
   status (ya llegan con `pricing.billable=true`) y confirmar **con qué string llega la
   categoría de servicio** — ¿`"service"`? ¿`"utility"`? — para que
   `normalizeRateCategory` la mapee bien. Una etiqueta inesperada NO debe dejar el costo
   en 0 en silencio (la alerta por categoría no reconocida se agrega en E2).
3. **Tramos de volumen:** revisar si Meta publicó tramos por volumen para servicio (hoy
   el modelo usa list rate / tramo 0).
4. **`usdToClp`:** revisar el tipo de cambio de referencia (`CLP_PER_USD_REF`) usado para
   el round-trip CLP↔USD.

## Decisión de pasarela (pendiente de confirmar)

Alineado con la estrategia de Cláriva: **CLP para Chile, USD para el resto**. Para USD, Stripe es el más directo (requiere entidad/LLC o Merchant of Record como Paddle/Lemon Squeezy para evitarla). Para CLP local: Flow/Transbank Webpay. La abstracción `PaymentProvider` permite conectar cualquiera sin tocar el resto del sistema.
