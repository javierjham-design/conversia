# Arquitectura de facturación

Cobro directo a los tenants. Dos pasarelas por moneda, tras una abstracción común.

## 1. Abstracción de proveedor (`apps/api/src/billing/payment-provider.ts`)

```
interface PaymentProvider {
  createCheckout(input): Promise<{ url, ref }>
}
createPaymentProvider(currency):
  CLP + claves Flow      → FlowPaymentProvider   (pasarela chilena)
  otra + claves Stripe   → StripePaymentProvider (Checkout mode=subscription)
  sin claves             → MockPaymentProvider   (desarrollo)
```

- **Stripe:** Checkout con `price_data` recurrente inline; `ZERO_DECIMAL` contempla
  monedas sin decimales. Firma de webhook verificada (`t=…,v1=…`, HMAC-SHA256).
- **Flow:** `payment/create` firmado (HMAC-SHA256 sobre pares clave+valor ordenados);
  confirmación por `getStatus` firmado (`status === 2` = pagado).
- **Mock:** confirma al instante para desarrollar sin credenciales.

Ningún secreto viaja al frontend. Las claves viven sólo en el entorno del backend.

## 2. Flujo

```
POST /billing/checkout            → crea sesión en la pasarela (según moneda) y
                                     devuelve la URL de pago
POST /billing/webhooks/stripe     → verifica firma; checkout.session.completed → activate()
POST /billing/webhooks/flow       → getStatus firmado; status 2 → activate()
POST /billing/mock-confirm        → sólo dev
```

`activate(orgId, planCode, provider, providerRef?)` (privado, compartido):
activa/renueva la suscripción y emite la factura `PAID` con `providerRef`.

Las rutas `/billing/webhooks` son públicas (validan **firma propia**, no JWT) y
están en `PUBLIC_PREFIXES`.

## 3. Estado actual

- ✅ Checkout Stripe + Flow, selección por moneda.
- ✅ Webhooks firmados que activan la suscripción y emiten factura.
- ✅ Facturas visibles en la ficha del tenant (Super Admin).
- ⚠️ Faltan credenciales reales de producción (Stripe/Flow) — estructura lista,
  falta conectar claves en el entorno.

## 4. Fase D — pendiente (bloque de migración)

Requiere DDL vía conexión directa (el rol `conversia_app` no tiene DDL):

| Ítem | Necesita |
|------|----------|
| **Idempotencia de webhooks** | Tabla `webhook_events` (dedupe por `provider+eventId`) para no procesar dos veces un pago/reintento |
| **Ciclo completo Stripe** | `invoice.payment_failed`, `customer.subscription.updated/deleted`, dunning, reembolsos |
| **Conciliación Flow** | Job que reconcilia pagos pendientes/rechazados |
| **Cupones / créditos / add-ons** | Tablas `coupons`, `credits`, ítems de add-on en la suscripción |
| **Versionado de planes** | `plan_versions` para que cambiar un precio no altere lo contratado |
| **Reintentos y estados** | `PAST_DUE`, `UNPAID`, gracia, y su efecto en entitlements/suspensión |

### Plan de aplicación de la migración
1. Escribir la migración Prisma + **script de rollback**.
2. Aplicar por conexión **directa/superusuario** (no por deploy del contenedor).
3. Verificar RLS/roles sobre las tablas nuevas (`conversia_app` con las políticas
   correctas; el Super Admin usa `getAdminPrisma`).
4. Recién entonces cablear la lógica de aplicación.

> Se deja **pendiente** de forma deliberada: una migración de esquema en producción
> es difícil de revertir y debe hacerse en una ventana controlada, no de forma
> desatendida (ver riesgos residuales en SUPER_ADMIN_SECURITY.md).
