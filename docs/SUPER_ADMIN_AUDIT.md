# SUPER_ADMIN_AUDIT.md — Auditoría del Super Admin de TuBot.cl

Auditoría previa a la iteración de endurecimiento y expansión comercial del Super Admin.
Fecha: 2026-07-28. Alcance: administración de plataforma, tenants, planes, límites, suscripciones,
billing (Stripe/Flow), consumo, seguridad del acceso Super Admin, auditoría y sincronización con la web pública.

---

## 1. Arquitectura encontrada

**Monorepo** pnpm+turbo: `apps/api` (NestJS), `apps/worker` (BullMQ), `apps/web` (Next 15). PostgreSQL 18 + pgvector + Prisma 6 + RLS. Redis. Hosting Railway.

**Multi-tenancy (real):** RLS por `organization_id`; `withTenant(orgId, fn)` fija el GUC `app.org_id` por transacción. El `organizationId` **nunca** viene del cliente (sale del JWT o del canal receptor del webhook). Cliente Prisma **dual**: rol `conversia_app` (SIN BYPASSRLS) para datos de tenant + cliente admin (superusuario) solo para registro/login/ruteo/plataforma.

**Identidad del tenant:** JWT HS256 (`apps/api/src/auth/jwt.ts`), issuer+audience de tenant, jti. `TenancyMiddleware` valida el token y abre el contexto (AsyncLocalStorage). `PUBLIC_PREFIXES` = `/auth/login`, `/auth/register`, `/auth/google`, `/webhooks`, `/billing/webhooks`, `/health`.

**Super Admin (plataforma) — YA SEPARADO:**
- Tabla propia **`platform_admins`** (email, passwordHash, name) — identidad separada de `users`.
- Login propio **`POST /platform/auth/login`** (rate-limit por email, bcrypt, audita `platform.login`).
- JWT propio: **audiencia `conversia-platform`** + claim `platform:true` + jti, expira **8h** (`platform.jwt.ts`). `verifyPlatformToken` valida algoritmo HS256 fijo + issuer + audiencia + claim.
- **`PlatformGuard`** protege todas las rutas `/platform/*`.
- Rutas `/platform/*` **excluidas** del `TenancyMiddleware` (`app.module.ts`).
- `platform.controller.ts`: métricas, organizaciones (listar/detalle/estado), planes (CRUD precios/límites), suscripciones, facturas — con el cliente **admin** (cross-tenant) y **auditando cada mutación**.
- Panel web en **`apps/web/src/app/admin/*`**: login/layout propios, token en `localStorage` con clave separada `conversia_platform_token` (`lib/platform-api.ts`).
- **Aislamiento de audiencias verificado** (esta sesión): token de tenant → `/platform` = **401**; token de plataforma → `/agents` = **401**.

**Billing:** abstracción `PaymentProvider` (`apps/api/src/billing/payment-provider.ts`) con `MockPaymentProvider`, **`StripePaymentProvider`** (Checkout suscripción, sin SDK) y **`FlowPaymentProvider`** (payment/create firmado); `createPaymentProvider(currency)` elige CLP→Flow / resto→Stripe / mock. Webhooks firmados `POST /billing/webhooks/{stripe,flow}` → `activate()` (activa/renueva suscripción + emite factura). Modelos `plans` (4 seed: free/starter/pro/enterprise con `limits` JSON), `subscriptions`, `invoices`, `payment_methods`, `usage_events`.

**Límites:** `enforcePlanLimit(tx, recurso, count)` (`apps/api/src/common/plan-limits.ts`) aplica 403 al exceder en crear **agentes/canales/flujos/usuarios**. Tope diario de **tokens IA** por tenant en el worker (`plan.limits.aiTokensDaily`) + kill-switch global y por tenant.

**Web pública:** landing en `tubot.cl` (`apps/web/src/app/page.tsx`) con **precios de planes ESCRITOS A MANO** (no consume API).

---

## 2. Funciones REALES (verificadas)

- Separación de identidad del Super Admin (tabla + audiencia + guard + exclusión de RLS middleware). ✅
- Rate-limit + bcrypt + auditoría en login de plataforma. ✅
- Enforcement duro de límites agentes/canales/flujos/usuarios (403). ✅
- Tope diario de tokens IA + kill-switch (global/tenant). ✅
- Stripe + Flow: checkout + webhooks firmados → activa suscripción + emite factura. ✅ (desplegado; falta conectar credenciales)
- Facturas (manual + webhook), suscripciones, auditoría (`audit_logs`). ✅

## 3. Funciones SIMULADAS o PARCIALES

- `MockPaymentProvider` en dev. **Precios públicos hardcodeados** en la landing (no API).
- **Medición de uso**: existen `usage_events` + tokens IA, pero **sin reserva/commit/release atómico**, **sin métrica de conversaciones iniciadas** ni **clientes activos**, ni almacenamiento/audio/mensajes.
- **Límites**: solo 4 recursos + tokens IA. Faltan conversaciones, clientes activos, números WhatsApp, mensajes, storage, webhooks, etc. **No hay motor de entitlements central**.
- **Suspensión**: existe `organization.status` pero **sin enforcement real** por niveles (solo-lectura, sin-IA, sin-envío…).
- Sin **add-ons, cupones, créditos, versionado de planes, overrides por sede**.
- Sin **RBAC** dentro de `platform_admins` (todo admin = todos los permisos).

## 4. Integraciones pendientes

- Stripe: ciclo completo (Customer Portal, `invoice.paid` renovaciones, refunds, coupons) + credenciales reales.
- Flow: conciliación, devoluciones/suscripciones según capacidades, credenciales reales.
- Cloudflare Access / VPN / IP allowlist para el perímetro del Super Admin.
- MFA/TOTP.

---

## 5. Riesgos y falencias (priorizados)

| # | Sev | Hallazgo |
|---|---|---|
| R1 | **ALTO** | Super Admin **sin MFA** — solo email+password. |
| R2 | **ALTO** | Super Admin **descubrible**: `/admin` y `/platform/auth/login` son rutas públicas predecibles, **sin perímetro** (Cloudflare Access/VPN/IP allowlist) ni `noindex`. |
| R3 | MEDIO | **Secreto compartido**: el JWT de plataforma usa el mismo `JWT_SECRET` que el de tenant (solo difiere la audiencia). Ideal: `SUPER_ADMIN_SESSION_SECRET` separado. |
| R4 | MEDIO | **Sin gestión de sesiones** de plataforma (revocación, sesiones visibles, expiración por inactividad, rotación de refresh). Token de 8h no revocable. |
| R5 | MEDIO | **Sin reautenticación** para acciones críticas (precio, suspensión, créditos, reembolsos). |
| R6 | MEDIO | **Límites incompletos** y sin motor de entitlements central → funciones sin cuota real. |
| R7 | MEDIO | **Uso de tokens IA sin reserva atómica** (check-then-act): riesgo de sobreuso por concurrencia/reintentos/race. |
| R8 | MEDIO | **Precios públicos hardcodeados** → desincronización con los planes reales. |
| R9 | BAJO | **Sin RBAC** en `platform_admins`. |
| R10 | BAJO | **Idempotencia de webhooks no registrada** (`webhook_events`): riesgo de doble activación por replay (firma sí se valida). |

> **Aclaración sobre "cómo Digital Dent pudo ingresar al Super Admin":** la **separación de identidad es correcta y server-side** — un usuario de tenant (Digital Dent) **NO puede autenticarse** en `/platform/*` (necesita estar en `platform_admins` y un token de audiencia `conversia-platform`). El riesgo real es **R2 (descubribilidad)** + **R1 (sin MFA)**, no un bypass de identidad. No se detectó ruta que permita a un token de tenant elevar a plataforma.

---

## 6. Archivos involucrados

- Plataforma: `apps/api/src/platform/{platform.controller,platform-auth.controller,platform.guard,platform.jwt}.ts`
- Tenancy/seguridad: `apps/api/src/tenancy/tenancy.middleware.ts`, `apps/api/src/common/{rate-limit,crypto,all-exceptions.filter}.ts`, `apps/api/src/main.ts`, `apps/web/next.config.mjs`
- Billing: `apps/api/src/billing/{billing.controller,payment-provider}.ts`
- Límites/uso: `apps/api/src/common/plan-limits.ts`, `apps/worker/src/agent-turn.ts`, `packages/database` (usage_events)
- Web admin: `apps/web/src/app/admin/*`, `apps/web/src/lib/platform-api.ts`
- Web pública: `apps/web/src/app/page.tsx`
- Datos: `packages/database/prisma/schema.prisma`, `packages/database/src/seed.ts`

---

## 7. Cambios propuestos — plan por FASES

**Fase A — Seguridad del Super Admin (prioridad máxima).** noindex/no-descubrible (`X-Robots-Tag`, robots.txt, sin enlaces), **MFA TOTP obligatorio** (enrolamiento + verificación en login + códigos de recuperación), `SUPER_ADMIN_SESSION_SECRET` separado, **reautenticación** para acciones críticas, sesiones/revocación, **RBAC** de plataforma, documentar perímetro (Cloudflare Access — pendiente de infra).

**Fase B — Motor de entitlements y límites reales.** Interfaz central (`canUseFeature/getFeatureLimit/getUsage/reserve/commit/release/enforceLimit/getEntitlements`), aplicada en todos los módulos que consumen recursos; límites completos por plan; contadores atómicos.

**Fase C — Medición de uso.** Conversaciones iniciadas (idempotente por ventana), clientes activos (snapshots), reservas de tokens (reserve→commit→release), reconciliación, presupuestos por periodo/minuto.

**Fase D — Billing completo.** Stripe ciclo completo (Customer Portal, todos los eventos, refunds, coupons, idempotencia `webhook_events`); Flow completo (conciliación, estados); add-ons, cupones, créditos, **versionado de planes**, overrides por tenant/sede.

**Fase E — API pública de precios + sync web.** `GET /public/plans` (solo campos públicos) + la landing consume la API + invalidación de caché.

**Fase F — UI Super Admin.** Dashboard con métricas/gráficos/alertas, ficha de tenant con pestañas, editor de planes completo, facturación, consumo, seguridad.

**Fase G — Operación.** Suspensiones reales por nivel, impersonación de soporte auditada, alertas, y batería de tests (bypass, concurrencia, webhooks, RLS, MFA).

---

## 8. Riesgos de regresión

- Tocar `TenancyMiddleware`/RLS/`auth` puede romper login o el aislamiento entre tenants → cambios mínimos + verificador de aislamiento (`verify:isolation`) tras cada cambio.
- Migraciones nuevas (MFA, entitlements, webhook_events, add-ons…) deben ser **aditivas, con rollback, sin borrar datos**.
- El motor de entitlements toca rutas de consumo (IA, conversaciones) — riesgo de bloquear operación diaria si un default es incorrecto → defaults seguros (permitir si no hay plan) + feature flag de enforcement.
- Cambiar el secreto/audiencia del Super Admin invalida sesiones activas (aceptable, se re-loguea).

## 9. Estado de producción (de esta auditoría)

**Aprobado con observaciones.** La plataforma opera y la separación de identidad del Super Admin es correcta. Las observaciones **R1 (MFA)** y **R2 (perímetro/descubribilidad)** deben cerrarse **antes** de operar comercialmente con dinero real y datos de pacientes. El resto es expansión funcional por fases.
