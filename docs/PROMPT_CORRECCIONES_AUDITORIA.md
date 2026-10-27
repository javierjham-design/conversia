# PROMPT DE DESARROLLO — Correcciones de la auditoría TuBot + Conversia (oct-2026)

> **Cómo usarlo:** pega este documento completo al inicio de cada sesión de desarrollo. El desarrollador ejecuta **UNA etapa por sesión** (la primera que no figure como mergeada en la tabla de estado al final), abre **un PR por etapa** y se detiene. Fuente de verdad de los hallazgos: `docs/AUDITORIA_TUBOT_CONVERSIA_2026-10.md` (las referencias `§x.y` apuntan ahí).

---

## Contexto que debes saber antes de tocar nada

- Monorepo pnpm/turbo. Un solo backend (`apps/api` NestJS + `apps/worker` BullMQ + Postgres con RLS + Redis) sirve a **dos marcas**: **TuBot** (`apps/web`, tubot.cl) y **Conversia** (`apps/conversia-web`).
- **TuBot tiene clientes pagando y operando 24/7.** Cada merge a `main` se despliega solo en Railway. Un error en api o worker deja mudos a bots de clientes reales.
- Lee `CLAUDE.md` (reglas de tenancy, `withTenant`, zod, idempotencia) y la sección correspondiente del informe de auditoría antes de cada etapa.

## Reglas no negociables

1. **TuBot byte-for-byte.** Ningún cambio altera el comportamiento visible de un tenant `brand = tubot` salvo el que la etapa pide explícitamente. Toda lógica nueva específica de Conversia nace detrás de `brand === "conversia"` (y flag si aplica).
2. **Desplegable en caliente.** Sin migraciones, sin cambios de variables de entorno obligatorias y sin cortes. Si una corrección requiere migración, **no la hagas**: déjala anotada en el PR como "requiere OK del dueño" y sigue con el resto.
3. **No tocar producción.** Nada de `railway run`, `railway variables`, psql contra prod ni scripts contra la BD real. Lo que requiera acción en Railway se entrega como pasos en el PR para el dueño.
4. **Un PR por etapa**, rama `fix/auditoria-<etapa>`, título `fix(auditoría <etapa>): …`. No mezclar etapas.
5. **Cada fix con su test** (vitest) que falle antes y pase después. `pnpm typecheck` y `pnpm test` en verde. No bajar cobertura existente.
6. **Defensa en profundidad:** cuando la corrección sea "agregar `organizationId` al `where`", hazlo aunque la RLS ya lo cubra.
7. **No refactorizar de paso.** Cambios mínimos y localizados; nada de renombres ni limpiezas fuera del alcance.
8. Al cerrar la etapa: actualizar la tabla de estado al final de este documento en el mismo PR y describir en el PR cómo verificar en producción tras el deploy.

---

## ETAPA 0 — Verificación operativa (la hace el dueño, sin código)

No empieces la etapa 1 sin estas tres respuestas en la tabla de estado:
1. Usuario de `DATABASE_URL` en servicios **api** y **worker** (`postgres` o `conversia_app`). Si es `postgres`: **detener** y avisar; la etapa 2 pasa a ser la primera y se agrega desactivar la purga de retención.
2. Memoria usada y `maxmemory-policy` de Redis.
3. Consumo del día de los fusibles `msgcap:g:<fecha>` y `msgcap:svc:g:<fecha>` frente a sus techos.

---

## ETAPA 1 — Hotfixes de una línea que protegen a TuBot hoy

1. **Mensajes reales descartados por `"mock:`** (§4.1) — `apps/api/src/channels/whatsapp.controller.ts:44-56`. Decidir si es mock inspeccionando el body parseado: `entry[].changes[].value.metadata.phone_number_id` que empiece por `mock:`. Test: un payload real con texto `hola "mock:` pasa la verificación HMAC y se encola; uno con `phone_number_id: "mock:x"` sigue exigiendo el token.
2. **Usuario "Solo lectura" cambia la cuenta de cobro** (§3.1) — `apps/api/src/charging/charging.controller.ts:194` (`PUT /charging`) y `POST /charging/link`: `requirePermission("settings:write")` en el PUT; el link exige `inbox:write`. Registrar `auditLog` del cambio de credenciales (sin valores).
3. **Credenciales globales de Flow/Lemon editables desde Conversia** (§6.2) — `apps/api/src/platform/platform.controller.ts:1384` (`POST billing/settings`) y `POST billing/flow/test`: rechazar con 403 si la marca del admin no es `tubot`.
4. **Alerta "sin responder" sin destinatarios** (§8.5) — `packages/notifications/src/catalog.ts:20-27`: agregar `"tenant_admins"` a la audiencia de `conversation.unanswered`. Test de `resolveRecipients` con conversación sin asignar → devuelve los admins.
5. **Login de TuBot recarga sin mostrar el error** (§10.1) — `apps/web/src/lib/api.ts:28-32`: no redirigir en 401 si la ruta es de auth (`/auth/login`, `/auth/register`, `/auth/mfa/*`, `/auth/accept-invite`, `/auth/invite`) o si ya estás en `/login`; devolver el `message` del backend. Copiar el patrón de `apps/conversia-web/src/lib/api.ts:79-99`.
6. **Notas internas de la IA entran al prompt** (§7.1) — `apps/worker/src/ai-notes.ts:61-68`: filtrar `authorType: "USER"` en `getMarkedInternalNotes`. Test: una nota `bot: …` creada por `addInternalNote` (AGENT) no aparece en el bloque.

**Criterio de cierre:** 6 tests nuevos en verde; ningún cambio de comportamiento para un tenant TuBot fuera de estos 6 puntos.

---

## ETAPA 2 — Aislamiento entre clientes (filtro explícito de organización)

Agregar `organizationId` (del contexto o del job) al `where` de estas consultas. Todas dentro de `withTenant`, sin migración.

1. `apps/worker/src/agent-turn.ts:524-527` — modo dueño: `role.findMany` y `organizationUser.findFirst` con `organizationId`. **Además** derivar el dueño de la identidad de WhatsApp (`contactIdentity` del canal WHATSAPP_CLOUD con `externalId` = teléfono del usuario) y no de `contact.phone`; si la conversación no es de WhatsApp, `ownerContext = false` (§2.1, §7.5). También `:148`, `:215`, `:230`.
2. `apps/api/src/assisted-setup/assisted-setup.controller.ts:113, 119-122, 209-212, 245-248` (§1.2).
3. `apps/worker/src/retention-purge.ts:37-53` (§2.0 fila 1): `organizationId` en `findMany`, `deleteMany` y `message.updateMany`.
4. Desconexión de integraciones (§2.0 fila 2): `apps/api/src/integrations/integrations.controller.ts:495, 595, 681, 780, 1172`; `apps/api/src/integrations/oauth.controller.ts:164, 211, 220, 291, 361, 472, 490`; `apps/worker/src/oauth-tokens.ts:85`; `apps/worker/src/google-calendar.ts:21, 121`; `apps/worker/src/hubspot.ts:167`.
5. Fallback "cualquier número/canal activo" (§2.0 fila 4): `apps/worker/src/channel-auth.ts:123`, `apps/worker/src/broadcast.ts:53`, `apps/worker/src/workflow-runtime.ts:51` → filtrar por la org; si no hay número propio, **fallar con mensaje claro**, nunca usar el de otro.
6. Workflows disparados por eventos (§2.0 fila 5): `apps/worker/src/workflow-runtime.ts:752, 817, 1014-1023`.
7. `packages/database/src/index.ts:128` (`resolveAgentByNameOrSlug`).
8. Exportaciones `apps/worker/src/exports.ts:40, 61, 86, 99`.
9. Búsqueda de contacto por teléfono: `apps/worker/src/contact-import.ts:63, 72`, `apps/worker/src/meta-leads.ts:156-157, 198`, `apps/worker/src/clariva-webhook.ts:72, 87, 179`.
10. Borrados y acciones por id: `apps/api/src/conversations/conversations.controller.ts:478-490`, `apps/api/src/contacts/contacts.controller.ts:635, 712, 720, 863-875`, `apps/api/src/users/users.controller.ts:430-431`.
11. **Chequeo de arranque** en `packages/database/src/index.ts`: al crear el cliente de tenant en `NODE_ENV=production`, consultar `rolsuper, rolbypassrls` del usuario actual; si alguno es true, `console.error` ruidoso + publicar `dbRoleOk:false` en `/health/status` (que devuelva 503). **No** tumbar el proceso (TuBot debe seguir arrancando). Además, que `getAdminPrisma` registre un aviso si falta `DIRECT_DATABASE_URL`.

Después, correr el escáner `node tools/audit/scan-tenant-filter.js apps/api/src apps/worker/src` (lista las llamadas `tx.<modelo>.<op>` cuyo argumento no menciona la organización; tiene falsos positivos cuando se filtra por un id ya validado) y listar en el PR los casos restantes por categoría; **no** corregirlos todos en esta etapa salvo `updateMany`/`deleteMany`.

**Tests:** para 1, 2, 3 y 5, un test que construya dos orgs y verifique que la operación de la org A no toca la org B (puede ser con el cliente mockeado verificando el `where`). `pnpm --filter @conversia/database verify:isolation` sigue en verde en CI.

---

## ETAPA 3 — Confiabilidad del bot 24/7

1. **Limpieza de jobs** (§8.2): `defaultJobOptions: { removeOnComplete: { age: 86400, count: 5000 }, removeOnFail: { age: 604800 } }` en todas las `Queue` de `apps/api/src/queues.ts` (conservando `attempts`/`backoff` de outbound) y en las que crea el worker (`platform-events.ts`, `webhook-sender.ts`, `ga4.ts`, `agent-turn-queue.ts`, `notifications/queue`). Incluir un script `tools/ops/clean-queues.mjs` (dry-run por defecto, `--confirm` para limpiar) que el dueño ejecutará fuera de horario.
2. **Cerrojo por conversación** (§8.1): al inicio de `runAgentTurn`, `SET conv:lock:<id> NX PX 120000`; si está tomado, re-encolar con `delay` 3 s y salir. Liberar en `finally` solo si el valor coincide. Además, descartar el turno si ya existe un OUTBOUND del agente posterior al último INBOUND.
3. **Bot mudo tras reintento del ingreso** (§8.3): en `apps/worker/src/inbound.ts`, encolar el turno inmediatamente después de persistir el mensaje (antes de flujos/eventos); en el camino duplicado (`:501`, `:754`) encolar el turno si no hay respuesta posterior (el encolado es idempotente por jobId); envolver cada efecto secundario posterior en su propio try/catch; **no** tragar el error de encolado (`:639`).
4. **Doble envío tras reintento** (§4.5, §8.4): en `apps/worker/src/outbound.ts` y en el envío de `agent-turn.ts`, claim atómico `updateMany({ where: { id, status: "PENDING" }, data: { status: "SENDING" } })` (si `count === 0`, salir); si el envío a Meta tuvo éxito y falla el `update`, reintentar solo el `update` y no relanzar. **Si `SENDING` no existe en el enum `MessageStatus`, NO crear migración:** usar un marcador en Redis `send:<messageId>` con TTL 24 h y anotar la migración como pendiente.
5. **Tope diario de tokens / kill switch en silencio** (§8.6): reutilizar el patrón `graceFallback` existente (frase de respaldo + `aiEnabled=false` + `ai.escalation`) y calcular el día en la zona horaria de la org. Mensaje del integration event con el tope efectivo.
6. **Scheduler** (§8.6): recuperar jobs `PROCESSING` con `updatedAt` > 5 min → `PENDING` (máx. 3 recuperaciones, contador en `payload` si no hay columna); el apagado espera el tick en curso.
7. **Apagado ordenado** (§8.6, informe A5-B5): cerrar todos los workers (incluido `messageImportsWorker`) con `Promise.race(close, 25 s)` y `lockDuration: 120000` en `agentTurn` e `inbound`.

**Tests:** cerrojo (dos turnos concurrentes → uno re-encolado), camino duplicado encola turno, outbound no reenvía si ya está SENDING/SENT, tope agotado responde frase de respaldo.

---

## ETAPA 4 — Dinero

1. **Proveedor de pago falso** (§9.1) — `apps/worker/src/subscription-billing/resolve-provider.ts`: en producción nunca devolver `FakeSubscriptionProvider`; lanzar error + `opsAlert`/`raiseException` y omitir el tick. `safeDecrypt` debe registrar el fallo (no devolver `""` en silencio). Permitir el falso solo si `ALLOW_FAKE_BILLING_PROVIDER=true` y `NODE_ENV !== "production"`.
2. **Orden intento/renovación** (§9.4) — `apps/worker/src/subscription-billing/engine.ts:81-83`: aplicar la renovación y marcar el intento `succeeded` al final (o en la misma transacción).
3. **Lemon Squeezy** (§9.2) — `apps/api/src/billing/billing.controller.ts:710-724`: acreditar/renovar solo en `subscription_payment_success`, deduplicando por el id del pago; `subscription_created/updated` solo actualizan estado. Manejar `subscription_cancelled`/`expired` → `cancelAtPeriodEnd`.
4. **Registrar pago y asignar suscripción sin recarga** (§9.3) — extraer la recarga de bolsa (`min(balance, cupo) + cupo` + ledger `plan_renewal`) a una función compartida y llamarla en `register_payment`, `assignSubscription(ACTIVE)`, `activate()` y `applySuccess`. Hacerla **atómica** con un solo `UPDATE … SET balance = LEAST(balance, $cupo) + $cupo … RETURNING balance` (§9.5).
5. **mock-confirm** (§9.5) — en producción bloquear siempre salvo `BILLING_MOCK_ENABLED=true`; exigir `requirePermission("billing:write")`; packs de mensajes idempotentes por `providerRef`.
6. **Débito fail-closed** (§9.5) — `apps/worker/src/messaging-guard.ts:168-206, 518`: separar topes/fusibles (fail-open) del débito de bolsa (1 reintento y luego bloqueo + alerta). Débito y asiento del ledger en la misma transacción en `apps/worker/src/wallet.ts:154-190`.
7. Anotar como **pendiente con migración** (no hacer): secuencia de numeración de facturas, unique parcial del ledger, columna `brand` en cupones.

**Tests:** proveedor falso nunca en prod; Lemon con 3 eventos del mismo pago → 1 acreditación; `register_payment` recarga; recarga concurrente con débito no pierde débitos.

---

## ETAPA 5 — Autenticación y permisos

1. **MFA reenrolable** (§3.3) — `apps/api/src/auth/auth.service.ts:446-451`: si `mfaEnabled`, exigir código TOTP actual o recovery code y contraseña.
2. **Google sin MFA** (§3.4) — `auth.service.ts:484-496`: misma bifurcación `mfaRequired`/`mfaSetupRequired` que `login()`.
3. **Impersonación** (§3.2): propagar `imp` del JWT al contexto; con `imp`, rechazar `/auth/switch`, `/auth/mfa/*`, cambio de contraseña y `PATCH /me`, y no emitir refresh; registrar `imp` en `auditLog`.
4. **Permisos faltantes** (§3.5): `inbox:write` en envío, plantillas, inicio, cierre, reasignación, CAPI, ejecutar workflow, takeover/release de `conversations.controller.ts`; `agents:write` en `PUT me/channels/:id/default-agent` y `:id/agent`; `settings:write` en `onboarding/vertical` y `me/clinics`; `reports:read` en exportaciones. **Antes**, revisar los roles por defecto de `seed.ts` y documentar en el PR qué rol pierde qué.
5. **Operador de plataforma** (§3.6): pasar `operatorMayAccess` a comparación en minúsculas y agregar a la denylist `organizations/:id/impersonate|admin/email|admin/reset-password|wallet-adjust|subscription|billing-action|payment-link|invoices|status|messaging-cap`.
6. **IP real** (§3.7): usar `req.ip` en `auth.controller.ts:61-63` y `platform.guard.ts:13-15, 37-42`.
7. **Rate limit** (§3.8): agregar límite por IP en login; para `login` y `mfa:*`, limitador en memoria de respaldo si Redis falla.
8. **Sesiones al desactivar o cambiar rol** (§3.9): `revokeAllSessions(userId)` en `users.controller.ts:278`; el login revisa `organization.deletedAt`. **No** bajar `JWT_EXPIRES_IN`.
9. **Refresh solo para quien lo usa** (§10.2): `issueTokens` emite refresh solo si la marca es `conversia` o el cliente envía `x-session-mode: sliding`. Verificar que conversia-web siga funcionando (jornada F).
10. Exención de MFA de plataforma evaluada sobre el path sin query (§3.10); `/auth/invite/:token` y `/auth/accept-invite` en rutas públicas si el frontend no envía Bearer (verificar antes con el código del frontend).

---

## ETAPA 6 — Coexistencia de marcas en `/platform` y fusibles

1. **Fusibles por marca** (§6.1) — `apps/worker/src/messaging-guard.ts:126-137, 306-317`: claves `msgcap:g:<brand>:<día>` y `msgcap:svc:g:<brand>:<día>`; topes `messagingCap*GlobalDay:<brand>` con fallback a la clave actual **solo para tubot** (así TuBot conserva su techo y contador actuales). `/health/fuse` devuelve estado por marca.
2. **Planes por marca** (§6.3): filtrar `GET /platform/plans` por la marca del admin, fijarla en `POST`, validar en `PATCH` (404 si no coincide).
3. **Escrituras globales** (§6.5): `PATCH cost-settings`, `messaging-limits`, `templates-pricing`, `POST test-ai`, cupones → solo marca `tubot` hasta tener claves por marca.
4. **Mutaciones por id sin marca** (§6.5): `PATCH/DELETE packages/:id`, `PATCH support/:id`, `PATCH/DELETE coupons/:id`, `invoices/:id/mark-paid`, `demo-leads/:id` → validar marca con `assertOrgBrand` o `findFirst({ id, brand })`.
5. **Doble guarda de features Conversia** (§6.6): `conversation-credits.ts:24-33` y `messaging-guard.ts:420-429` exigen `brand === "conversia" && feature`.
6. **Test de regresión "TuBot sin cambios"** (§6.10): job de CI bloqueante que verifique, para una org tubot con plan tubot: trial 7+7, `chargeServiceSend` no debita, sin `SUGGESTED`, `brandOf().mailFrom === RESEND_FROM`, ningún plan `brand=tubot` con `*DebitsWallet`.
7. **Test de alcance en `/platform`**: recorrer las rutas del controller y fallar si una ruta de escritura no valida marca ni está marcada como `tubotOnly`.

---

## ETAPA 7 — WhatsApp y canales

1. **Verificación de propiedad** (§4.3): en Embedded Signup, coexistencia, alta manual y PATCH que cambie `wabaId`/`phoneNumberId`, exigir que `GET /{wabaId}/phone_numbers` con el token del tenant contenga el `phoneNumberId`; abortar si `subscribed_apps` falla por permisos. Validar ids con `^\d{5,20}$` y `encodeURIComponent` en URLs de Graph.
2. **Fallback al token global** (§4.2, §4.6): eliminarlo en endpoints de tenant de `channels.controller.ts:1074-1092`; en el worker, permitirlo solo si `brand === "conversia"` o la cuenta está marcada como de plataforma.
3. **Resolución por `wabaId`** (§4.4): enrutar por `metadata.phone_number_id` cuando venga; rechazar en alta/PATCH un `wabaId` o activo Meta ya usado en otra org (chequeo con cliente admin).
4. **Errores de Meta** (§4.5): 131047 y 131026 terminales con mensaje claro; 130429/131056 con backoff largo; `limiter` de BullMQ en outbound; pacing en `broadcast.ts`.
5. **`/webhooks/meta-crm`** fail-closed sin secreto en producción, `jobId` + `attempts: 5`.
6. **Coexistencia** (§5): eco del dueño desde la app → `aiEnabled = false` + notificación, con reanudación automática configurable por canal (default 2 h). Solo afecta canales con `config.coexistence = true`.
7. Estados monótonos (no bajar de READ ni pisar FAILED) y org suspendida/canal inactivo no disparan flujos ni notificaciones (§4.6).

---

## ETAPA 8 — IA, frontends y cierre

1. Memoria de contacto sanitizada al guardar y formatear; bloque envuelto como datos (§7.2).
2. `leerWeb` y `/public/crear/draft`: resolución DNS, bloqueo de IPs internas, `redirect: "manual"` validando cada salto y lectura con tope de bytes (§7.3).
3. `confirmAppointment` valida el id contra las citas del contacto (§7.3).
4. MCP acepta `Authorization: Bearer`, rate limit por token y tope de 10 por lote (§7.3).
5. Modelo sin precio → aviso + precio conservador; pin `@anthropic-ai/sdk` a `^0.135.0` (§7.3).
6. CSV seguro: helper `csvCell` que neutraliza `= + - @ \t \r` en todos los exportadores (§10.5).
7. Conversia: redirección `volver` validada por origen; `error.tsx`/`not-found.tsx` (§10.3, §10.5). **Los textos legales (§10.4) los completa el dueño**: dejar el PR con los campos marcados.
8. Recuperación de contraseña autoservicio en ambas marcas: `POST /auth/forgot` (respuesta uniforme, rate limit) + `POST /auth/reset` (token de un solo uso, 1 h, revoca sesiones) (§10.5).
9. `seed.ts` aborta en `NODE_ENV=production` sin `ALLOW_PROD_SEED=true`; sin contraseñas por defecto; actualizar `RUNBOOK_GOLIVE_V2.md` reemplazando el `db:seed` completo por los scripts acotados (§1.3).
10. Bajas: strings "Conversia" en el panel TuBot, `autoComplete` en login TuBot, descargas con `res.ok`, deep link de push validado (§10.6).

---

## Formato del PR de cada etapa

- Qué hallazgos cierra (con `§x.y`) y cuáles quedan pendientes y por qué.
- Tests agregados.
- **Impacto en TuBot:** "ninguno" o descripción exacta del cambio visible.
- **Verificación post-deploy** (pasos concretos para el dueño: qué mirar en `/health/status`, qué probar en el panel).
- **Rollback:** revertir el PR (todas las etapas son sin migración).

## Estado de las etapas (actualizar en cada PR)

| Etapa | Estado | PR | Fecha | Notas |
|---|---|---|---|---|
| 0 — Verificación Railway | ✅ completa | — | 2026-10-26 | rol BD: ✅ `conversia_app` en api y worker, `DIRECT_DATABASE_URL` = `postgres` en ambos (RLS activa; etapa 2 = defensa en profundidad) · Redis: ~40 MB, crecimiento casi plano · fusibles: 0 plantillas y 27 de servicio frente a los techos por defecto (1.500 y 20.000), nunca se han cortado |
| 1 — Hotfixes | ✅ en PR #537 | #537 | 2026-10-26 | §4.1 mock por `phone_number_id` (no por texto) · §3.1 cobros: `settings:write`/`inbox:write` + auditoría · §6.2 billing global solo `tubot` · §8.5 `conversation.unanswered` → `tenant_admins` · §10.1 login TuBot muestra el error (no recarga) · §7.1 notas al prompt solo `authorType USER`. 8 tests nuevos. Sin cambios visibles para TuBot fuera de estos 6 puntos. |
| 2 — Aislamiento | ✅ en PR #545 | #545 | 2026-10-27 | Filtro `organizationId` explícito. Agujeros reales cerrados: modo dueño por identidad de WhatsApp (§2.1/§7.5, ya no por `contact.phone`) y fallback de número que podía usar el de otro cliente (§2.0 fila 4, ahora falla con motivo claro). + §1.2 montaje asistido, §2.0 filas 1/2/5, `resolveAgentByNameOrSlug`, exports, búsqueda por teléfono, borrados por id. Colaterales: webhook Cláriva por `externalId` y status de Meta por wamid cruzaban tenants. Chequeo de arranque `rolsuper/rolbypassrls` → `/health/status` 503 con `dbRoleOk:false` (sin tumbar el proceso). TODAS las `updateMany`/`deleteMany` cerradas; quedan 6 justificadas (3 `paymentAttempt` por `commerceOrder` @unique, purga global de exports, claim por PK del scheduler, 1 falso positivo). 18 tests nuevos; worker 337/337, api 195/195. Escáner: 1.317 casos restantes listados por categoría en el PR; cerrarlos al 100% exige unique compuesto `(organizationId,id)` → **requiere OK del dueño** (migración). |
| 3 — Confiabilidad 24/7 | ✅ en PR #546 | #546 | 2026-10-27 | §8.2 retención en 21 colas + `tools/ops/clean-queues.mjs` (dry-run) · §8.1 cerrojo `conv:lock` (NX/PX 120s) con reencolado a 3s + descarte si el agente ya respondió · §8.3 efectos aislados, el error de encolado ya no se traga y el camino duplicado RESCATA el turno · §4.5/§8.4 claim `send:<id>` en Redis: el reintento no reenvía, solo reconcilia · §8.6 tope/kill switch con frase de respaldo + aiEnabled=false + ai.escalation, día en la zona de la org y tope EFECTIVO en el evento · §8.6 recuperación de PROCESSING (máx 3, y FAILED si dueAt >24h para no mandar recordatorios viejos) · §8.6 apagado de los 14 workers (faltaba messageImports) con race 25s + lockDuration 120s. 18 tests; worker 355/355, api 195/195. DECISIONES: cerrojo acotado al turno del ingreso (los anidados correrían contra sí mismos); el encolado NO se movió antes de los flujos (saltearía `flowTookMessage`/`apptResponse` → respuesta doble, incidentes Salinas y GIGI); los ecos de coexistencia no encolan turno. MIGRACIONES PENDIENTES: `SENDING` en `MessageStatus` y `scheduled_jobs.updated_at` + contador de reintentos. |
| 4 — Dinero | pendiente | | | |
| 5 — Auth y permisos | pendiente | | | |
| 6 — Marcas y fusibles | pendiente | | | |
| 7 — WhatsApp y canales | pendiente | | | |
| 8 — IA, frontends y cierre | pendiente | | | |
| Migraciones diferidas | requiere OK del dueño | | | facturas por secuencia, unique ledger, `brand` en cupones, `SENDING` en enum, último contador TOTP |
