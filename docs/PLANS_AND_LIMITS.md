# Planes, entitlements y medición de uso

Punto único de verdad de **qué puede hacer cada tenant y cuánto**. Todo se
resuelve **server-side** dentro de `withTenant` (RLS). El frontend nunca decide
límites; sólo los muestra.

## 1. Catálogo de planes

Tabla `plans` (gestionada por el Super Admin en `/admin/plans`):

| Campo | Uso |
|-------|-----|
| `code` | Identificador estable (`free`, `starter`, `pro`, `enterprise`) |
| `name` | Nombre comercial |
| `priceClp` / `priceUsd` | Precio por moneda |
| `interval` | `monthly` \| `yearly` |
| `isPublic` | Si aparece en la web pública (`/public/plans`) |
| `active` | Si se puede contratar |
| `order` | Orden de presentación |
| `limits` | JSON `{ agents, channels, workflows, users, clinics, aiTokensDaily }`. `0` = ilimitado |
| `features` | JSON de flags (`{ api, whiteLabel, ... }`) |

Valores actuales (seed): Free (0 CLP), Starter (69.900), Pro (119.900). Enterprise
es privado / a medida.

## 2. Motor de entitlements (`apps/api/src/common/plan-limits.ts`)

Único módulo que traduce plan+suscripción → permisos. **No** hay `if (org === …)`.

- `getEntitlements(tx)` → `{ hasSubscription, status, planCode, limits, features }`
  a partir de la suscripción `ACTIVE`/`TRIALING` más reciente y su plan.
- `getFeatureLimit(tx, resource)` → número (o `null` si no hay plan).
- `canUseFeature(tx, feature)` → `boolean` desde `features`.
- `getSubscriptionStatus(tx)`.
- `enforceLimit(tx, resource, currentCount)` → **403** al alcanzar el tope.
  `enforcePlanLimit` es alias (compatibilidad con los controladores existentes).

**Regla de seguridad de negocio (2026-08-04):** sin suscripción activa ⇒ **límites del
plan `free`** (nunca ilimitado); si el plan `free` no existe en el catálogo, se cae a
`FREE_FALLBACK_LIMITS` (agents 2, channels 1, workflows 3, users 2, clinics 1). Un
límite `0` **dentro de un plan contratado** sí significa ilimitado (Enterprise). Nota:
un tenant sin plan que hoy exceda esos límites conserva lo que tiene, pero no puede
crear más hasta contratar (incluye el tenant semilla → asignarle un plan si necesita
más).

### Suspensión por impago (dunning)
- **Período de gracia: 7 días** (`BILLING_GRACE_DAYS`). Al vencer `periodEnd` sin
  renovar: la suscripción pasa a `PAST_DUE`, el servicio **sigue operando** y se avisa
  al admin (evento `billing.past_due` + banner). Agotada la gracia, la organización
  pasa a `SUSPENDED`.
- **Al suspender:** el **bot deja de responder** (corte de IA en `agent-turn`) y los
  **flujos se detienen** (`dispatchEvent` no inicia runs si la org no opera). El
  **panel queda en solo lectura**: `BillingSuspensionGuard` (global) bloquea toda
  escritura con **402**, salvo `/billing`, `/auth`, `/platform`. **NADA se borra.**
- **Al pagar:** `activate()` repone `status ACTIVE` + suscripción `ACTIVE` + nuevo
  `periodEnd`; todo vuelve sin pérdida de datos.
- Lógica pura + tick en `apps/worker/src/billing-dunning.ts` (tick horario), con
  tests (`billing-dunning.test.ts`).

### Dónde se aplica
`agents`, `channels`, `workflows`, `users` llaman a `enforcePlanLimit` **dentro de la
transacción** antes de crear, contando los existentes en la misma `tx` (sin condición
de carrera de lectura-sucia dentro del `SERIALIZABLE`/tx).

## 3. Medición de uso (`usage_events` + consultas)

Tabla `usage_events` (`type`, `quantity`, `costUsd`, `meta`, `occurredAt`),
indexada por `(organizationId, type, occurredAt)`.

- **IA (tokens + costo):** el worker registra un evento `ai_tokens` por turno con
  `costUsd`, y **antes** de generar agrega el gasto del día y lo compara contra
  `limits.aiTokensDaily` (tope efectivo del plan) — corta si se excede.
- **Clientes activos (MAU):** contactos distintos con conversación en los últimos
  30 días (consulta sobre `conversations.lastMessageAt`).
- **Conversaciones iniciadas:** `conversations` creadas en el período (métrica
  estilo CBP de WhatsApp).

El Super Admin ve todo esto en la ficha del tenant (`GET /platform/organizations/:id`
→ `usage` por tipo + `metrics { activeClients, conversationsInitiated }`).

## 4. Sincronización con la web pública (Fase E)

`GET /public/plans` (sin auth) devuelve **sólo** campos públicos de planes
`isPublic && active`. La landing (`www.tubot.cl`) lo consume con `revalidate: 300`
y cae a un fallback si la API no responde. Editar un precio en `/admin/plans`
(PATCH) se refleja en la web tras el TTL de caché. **Nunca** se exponen costos,
márgenes, IDs internos ni overrides.

## 5. Pendiente (bloque de migración)

Requiere DDL (aplicar por conexión directa/superusuario; `db:deploy` es manual y el
rol `conversia_app` no tiene permisos DDL):

- **Snapshots de uso** por período (rollups mensuales para facturación por consumo).
- **Reserva atómica de tokens** (reserve/commit/release) para topes duros bajo
  concurrencia — hoy el control es por agregación previa al turno, suficiente para
  el volumen actual pero no atómico.
- **Add-ons / créditos** por suscripción.
- **Versionado de planes** (que cambiar un precio no altere retroactivamente lo
  contratado).
