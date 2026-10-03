# AUDITORÍA PRE-PRODUCCIÓN — Conversia (GO/NO-GO)

**Fecha:** 2026-10-02 · **Alcance:** Conversia sobre la plataforma multi-tenant que ya opera TuBot en producción. **Regla de oro:** nada de lo auditado puede degradar TuBot.
**Método:** auditoría independiente por dimensión (8 secciones del prompt `docs/PROMPTS_CONVERSIA.md` línea 1452) + verificaciones operativas en vivo. Solo lectura; este informe NO corrige, informa.

---

## VEREDICTO: 🔴 NO-GO (condicional)

El producto está **sustancialmente completo y el núcleo crítico es sólido** (aislamiento RLS, caja append-only inmutable, firmas de webhook, idempotencia de pagos, rol operador, regla de oro en el núcleo). **No hay ningún camino donde la IA escriba dinero ni donde se crucen datos entre tenants.**

Pero hay **3 BLOQUEANTES** y un grupo de **ALTOS** que impiden abrir Conversia al público tal como se fijó en el planner. La mayoría son **fugas de marca en el correo** (el cuerpo se branderizó pero el remitente/los links siguen siendo TuBot — el "barrido fino pendiente" que ya anotaba `CONVERSIA_ESTADO.md:33`), un **bug de concurrencia de dinero** de fix mecánico, y **brechas de diseño/producto vs el planner** (PWA, tipografía, barra de operación de la bandeja, agenda nativa F4). Todos tienen fix acotado.

**Resumen por severidad:** 3 BLOQUEANTES · 14 ALTOS · 13 MEDIOS · 8 BAJOS · + checklist operativo del dueño.

---

## EVIDENCIA OPERATIVA EN VIVO (verificado hoy)

| Check | Resultado |
|---|---|
| `app.conversia.cl` | **HTTP 200** + TLS válido (`<title>Conversia</title>`) |
| API prod `/auth/me` | **401** (ruta viva, guard activo) |
| Rutas F10 (`/platform/admins`, `/implementation`, `/client-context`, `/lifecycle/delivered`) | **401** (registradas) |
| `pnpm typecheck` (todo el monorepo) | **19/19 verde** |
| Tests API | **153 verde** (incl. 66 de política de operador, 6 de caja) |
| **Regla de oro** — grep `tubot` en `apps/conversia-web/src` + `public` | **4 hits, TODOS comentarios de código** (0 visible al usuario). Frontend conversia limpio. |
| RLS: verificador estático/isolation | **Corre en CI como job BLOQUEANTE** (`.github/workflows/security.yml`): `verify:rls` (cobertura) + `verify:isolation` (comportamiento con rol real sin BYPASSRLS) + gitleaks. (No ejecutable localmente sin BD; CI es la fuente de verdad.) |

---

## 🔴 BLOQUEANTES (no se lanza con estos abiertos)

| # | Área | Archivo:línea | Hallazgo | Fix sugerido |
|---|---|---|---|---|
| **B1** | Marca / correo | `apps/api/src/platform/platform.controller.ts:907-911` (`sendAdminReset`) | El correo de reseteo de contraseña al admin de un tenant **Conversia** dice "tu cuenta de TuBot", asunto "· TuBot" y enlaza `https://tubot.cl/login` (panel equivocado → link roto para Conversia). Fuga de marca + funcionalidad rota. | `const b = brandOf(org)` (el org ya es accesible vía `assertOrgBrand`); usar `b.name`, `b.webUrl + "/login"`, `from: b.mailFrom`. |
| **B2** | Marca / pago | `apps/api/src/billing/billing.controller.ts:326` (`startCollect`) + `:232` (registro de tarjeta) | Los retornos de Flow de la **suscripción recurrente** hardcodean `${env.WEB_URL}` (panel TuBot): un tenant Conversia que paga o registra tarjeta vuelve al panel de TuBot. (Los checkouts de pago único SÍ lo hacen bien — replicar ese patrón.) | Cargar `brandOf(org)` y usar `brand.webUrl` + `brand.paymentSubjectPrefix` en `urlReturn` y subject. |
| **B3** | Dinero / concurrencia | `apps/api/src/billing/billing.controller.ts:666-681` (`creditPackage`) | Acreditar un sobre es **read-modify-write NO atómico**: dos compras concurrentes (o compra + renovación) leen el mismo saldo y se pisan → **se pierden créditos pagados por el cliente**. Contrasta con el débito, que sí es atómico. | `UPDATE message_wallets SET balance = balance + ${credits} … RETURNING balance` (atómico, como el débito). |

---

## 🟠 ALTOS (cerrar antes del lanzamiento comercial / fidelidad al planner)

### Fugas de marca en correo/OAuth (raíz común: branderizar `From:` + `webUrl`, no solo el cuerpo)
| # | Archivo:línea | Hallazgo | Fix |
|---|---|---|---|
| A1 | `apps/api/src/auth/auth.service.ts:186` | Correo de **verificación (D6, solo Conversia)**: cuerpo/link correctos pero `sendEmail` sin `from` → sale desde `no-reply@tubot.cl`. Es el PRIMER correo del cliente Conversia (fuga + riesgo de spam, el From no coincide con el dominio verificado). | `from: brand.mailFrom`. |
| A2 | `apps/worker/src/mailer.ts:108-111` (`sendTenantEmail`) | Todo correo de tenant (escalaciones, resumen diario, alertas, workflow) sale `From: RESEND_FROM` (TuBot), ignorando la marca. | Resolver `brandOf(org)` y usar `brand.mailFrom`. |
| A3 | `apps/api/src/integrations/oauth.controller.ts:59-86` | Página de resultado OAuth (Google/HubSpot): usa `env.WEB_URL`, título "TuBot" y `postMessage` al origin de TuBot → fuga **+ la integración no notifica al panel Conversia (rota)**. | Resolver `brandOf(org)` por `orgId` del state y propagar webUrl/título/postMessage por marca. |
| A4 | `apps/worker/src/subscription-billing/billing-emails.ts:26,47,53` | Correos de **cobranza** (pago fallido/exitoso/suspensión): footer "TuBot", botón "Ir a pagar" → panel TuBot, `from` TuBot. Canal irrenunciable. | `brandOf(org)`: footer/`payUrl`/`from` por marca. |

### Dinero / seguridad / operación
| # | Archivo:línea | Hallazgo | Fix |
|---|---|---|---|
| A5 | `apps/api/src/platform/platform.controller.ts:153-191` (`/platform/metrics`); `platform-policy.ts` | El **operador** ve MRR, ingresos y costos de toda la marca vía `/platform/metrics` (no está en la denylist). Contradice `SUPER_ADMIN_SECURITY.md §6` ("operador no ve MRR/márgenes"). | Añadir `/platform/metrics` (y revisar `/quality`) a `OPERATOR_DENY_PREFIXES`, o separar un endpoint operacional sin cifras de dinero. |
| A6 | `apps/api/test/cash-ledger.spec.ts` | La regla 8 de F9 exige por nombre tests de **idempotencia (doble-click + webhook duplicado), permisos por rol y aislamiento RLS**; el test actual solo cubre `summarize` (función pura). Las garantías "no negociables" de dinero no tienen prueba automatizada. | Añadir tests de integración/controlador: idempotencyKey repetida → 1 fila; webhook `payment:${id}` duplicado → no duplica; `cash:manage` ausente → 403; `verify-isolation` sobre `cash_ledger`. |
| A7 | `apps/api/src/billing/billing.controller.ts` + `apps/worker/src/messaging-guard.ts` (ventana 24h) | **Sin enforcement server-side proactivo de la ventana de 24 h**: se confía en que Meta rechace el envío fuera de ventana (llega como `failed`). El planner pide "bloqueo + oferta de plantilla fuera". | Calcular la ventana (último INBOUND) antes de encolar; fuera → rechazar texto libre + sugerir plantilla. **Decisión del dueño:** ¿se acepta el comportamiento reactivo actual o se exige el proactivo? |
| A8 | `docs/DEPLOYMENT.md` (ausente) | **Rollback de deploy de código no documentado** (solo existe rollback de migraciones). Deploy es manual. | Documentar en DEPLOYMENT.md cómo revertir un deploy en Railway + la regla de migraciones aditivas/compatibles (api+worker+web comparten BD). |

### Diseño / producto vs planner (el dueño pidió fidelidad al planner)
| # | Archivo:línea | Hallazgo | Fix |
|---|---|---|---|
| A9 | `apps/conversia-web/` (sin `public/`, `layout.tsx` sin `manifest`) | **PWA ausente**: no hay manifest, service worker, offline ni íconos (apps/web sí los tiene). El planner pide "PWA instalable". | Portar manifest + SW + offline + íconos de marca Conversia; declarar `manifest` en `layout.tsx`. |
| A10 | `apps/conversia-web/src/app/globals.css:113-121` | **Tipografía Fraunces + Inter NO se carga** (solo declarada con fallback a serif/system; sin `next/font`, sin `@font-face`). En pantalla se ve serif/sans del sistema, no el diseño fijado. | Cargar ambas con `next/font/local` (self-host, compatible con la CSP). |
| A11 | `apps/conversia-web/src/app/conversaciones/page.tsx` | **Bandeja sin la barra de operación** del planner: faltan chips Agente ▾ / Asignada a ▾ / Etapa ▾ / + Etiqueta, indicador de **ventana 24 h**, tarjetas de evento del bot, "Ver ficha". | Añadir la barra de operación (los datos ya existen en la API). |
| A12 | `apps/worker/src/appointment-responses.ts` + `packages/scheduling/src/index.ts` (provider NATIVA) | **F4 incompleto**: la agenda NATIVA aún lanza `notYet()` para reagendar/cancelar/confirmar; el botón "Reagendar" del recordatorio deriva a humano. El planner marca el ciclo completo por chat como requisito (bloqueante para barbería). | Implementar reschedule/cancel/confirm en NATIVA con validación de disponibilidad transaccional. |
| A13 | `apps/api/src/auth/auth.service.ts:119-163` | **Acento por país no se persiste** al registrar (`accentForCountry` existe pero no se llama; el preview es solo localStorage). | En `register()` guardar `user.settings.accent = accentForCountry(org.country)`. |
| A14 | `apps/conversia-web/src/app/page.tsx:6-10` | **Saludo no usa la zona horaria del negocio** (usa la del navegador). El dato `organization.timezone` ya viene en `/auth/me`. | Calcular la hora con `Intl.DateTimeFormat` + `organization.timezone`. |

---

## 🟡 MEDIOS (seguimiento; algunos requieren confirmación del dueño)

| # | Archivo:línea | Hallazgo |
|---|---|---|
| M1 | `packages/config/src/index.ts` (guard de prod) | `META_APP_SECRET`, `MOCK_INBOUND_TOKEN`, `META_VERIFY_TOKEN`, `SUPER_ADMIN_SESSION_SECRET` tienen **default vacío/público y NO se exigen en el guard de producción**. Si alguno falta en prod: webhook sin verificar firma (crítico), inyección de inbound simulado, secreto de plataforma compartido con tenant. Fix: exigirlos en el guard de prod. |
| M2 | `packages/database/prisma/migrations/20261002180000_cash_ledger/migration.sql` | El `REVOKE UPDATE/DELETE` + RLS de caja viven **solo en `setup.sql`** (paso manual). Si se corre `migrate deploy` sin `db:setup`, las tablas de caja quedan mutables y sin RLS. (En prod actual SÍ se aplicó.) Fix: incluir el REVOKE+RLS en la propia migración. |
| M3 | `apps/worker/src/messaging-guard.ts:184-186` | `catch {}` "fail open" en el débito de bolsa: si falla la BD, el mensaje se envía sin cobrar, en silencio. Fix: emitir `system_alert`/contador al fallar el débito. |
| M4 | `apps/api/src/health.controller.ts:27-41` | El **fusible de servicio** (`msgcap:svc-fuse:`) NO se expone en `/health/fuse` (solo el de plantillas) → el monitor externo no alerta si se corta. Fix: incluirlo en `/health/fuse`. |
| M5 | `apps/conversia-web/src/app/conversaciones/page.tsx:390-404` | La bandeja **no muestra indicador de ventana de 24 h** en el hilo. (Relacionado con A7.) |
| M6 | `apps/api/src/auth/auth.controller.ts:43` | `PATCH /me/preferences` acepta 13 acentos, no los **6 curados**; un usuario Conversia puede fijar un acento sin tokens (sin efecto visual). Fix: validar contra los 6. |
| M7 | `apps/conversia-web/src/app/page.tsx:73-86` | Contador de créditos **sin proyección** en el Home (el endpoint ya devuelve `projected`). |
| M8 | `apps/conversia-web/src/app/conversaciones/page.tsx:73` | Breakpoint master-detail = **759px**, no 620px (desalineado con el riel/tabs). |
| M9 | `apps/conversia-web/src/components/AppShell.tsx:103-110` | Tab bar móvil muestra **8 ítems**, no el patrón "4 + Más" con globo de pendientes en Chats. |
| M10 | `apps/worker/` (sin parser `CV-`) | **F7**: el salto a WhatsApp con `CV-XXXX` no rehidrata el ticket en el inbound (el reinicio de navegador SÍ lo retoma, server-side). |
| M11 | `system_alerts` (schema) | Tabla **sin ningún escritor** en el código → el "panel de alertas in-app" no existe; las alertas reales dependen de BetterStack (setup del dueño). Fix: cablear un escritor o retirar la tabla muerta. |
| M12 | `apps/worker/src/service-metering.ts` | Contador de free tier usa **mes UTC** y cuenta al ENVIAR; Meta usa TZ de la WABA y cuenta ENTREGADOS. **Es solo estimador** (la verdad fiscal es `usage_events`). Ya planificado F5-B p2. Aceptable; confirmar con el dueño. |
| M13 | `packages/scheduling/src/dentalink.ts:246` | Al agendar en Dentalink el comentario dice "Agendada por TuBot" (visible en la ficha clínica del tenant Conversia). (La agenda nativa sí está branderizada.) |

---

## BRECHAS DEL FLUJO (punto 8 — los 4 viajes end-to-end)

El flujo redondo está **más completo de lo que sugerían los docs** (margen por tenant, dunning+read-only, caja reversa, export, retención, soporte con contexto, F8 con gate real). Brechas conocidas ("Qué queda fuera"): todas tienen camino manual documentado (`CICLO_VIDA_CLIENTE.md`, `INCIDENT_RESPONSE.md`, `SUPER_ADMIN_SECURITY.md §6`), con estas salvedades nuevas:

| # | Viaje | Brecha | Sev | Propuesta mínima |
|---|---|---|---|---|
| F-1 | Cliente/Dinero | **Permanencia nunca se registra al ENTREGAR**: `markDelivered` no escribe `settings.contract={commitmentMonths,startedAt}` que `CICLO_VIDA_CLIENTE.md §3` manda. Sin ese dato, el enforcement manual de la permanencia no tiene base ni fecha de inicio. | MEDIO | En `markDelivered`, persistir `settings.contract`; mostrarlo en la ficha. |
| F-2 | Dato | **El exportador omite la caja**; el doc de offboarding la promete. La caja (F9, append-only, fuente contable del tenant) no se entrega en la baja por el canal documentado (derecho de portabilidad). | MEDIO-ALTO | Añadir export `cash` (lee `cash_ledger`/`cash_closures` del tenant) o corregir el doc y entregarla por el CSV de `/cash`. |
| F-3 | Dato | **No hay purga automatizada post-baja** para tenants Conversia/pagos: `trial-lifecycle` los exenta y `retention-purge` solo recorta si el tenant configuró `settings.retention`. Un tenant dado de baja retiene todo indefinidamente salvo script manual. | MEDIO | Al cancelar/suspender fijar `settings.offboarding={cancelledAt, purgeAt=+90d}` + tick diario que purgue vencidos (patrón `retention-purge`). |
| F-4 | Operador/Seguridad | **MFA de plataforma es apagable con un env global sin alerta** (`SUPER_ADMIN_REQUIRE_MFA`); `SUPER_ADMIN_SECURITY.md §3` sigue diciendo "MFA pendiente" (doc desactualizado vs §6/§8 y código). | MEDIO | Alerta de arranque si está en `false`; corregir §3; confirmar en Railway que está en `true`. |
| F-5 | Operador/Dato | **Impersonación sin step-up TOTP**; verificar que el alcance esté acotado a cartera/marca (H33). Un operador lee datos de clientes finales de cualquier tenant de su marca sin reautenticación reciente. | MEDIO | Confirmar alcance por marca + auditoría con rol; step-up diferido (decisión tomada). |
| F-6 | Dato | `contact_memories` **huérfanas** al purgar conversaciones (solo se borran en cascada con el contacto). | BAJO | Incluir `contact_memories` en la purga por retención. |
| F-7 | Incidentes | `INCIDENT_RESPONSE.md` deja "Contacto responsable: (definir)" y "Canal por marca: definir" sin rellenar — el mínimo que el propio doc exige para lanzar. | BAJO-MEDIO | Rellenar remitente por marca + responsable. |
| F-8 | Seguridad | Rotación de `CREDENTIALS_ENCRYPTION_KEY` sin procedimiento (re-cifrado). | BAJO | Documentar el procedimiento o aceptar como riesgo residual. |

---

## CHECKLIST OPERATIVO DEL DUEÑO (bloqueante de lanzamiento, NO de código)

Verificado: estos NO están hechos o no son verificables desde el repo. Deben estar HECHOS (no prometidos) antes de abrir Conversia:

- [ ] **DNS apex `conversia.cl` + landing pública + páginas legales** (términos/privacidad): hoy `conversia.cl` **no resuelve** (NXDOMAIN); solo `app.conversia.cl` y `www`. La landing/legales no están en este repo.
- [ ] **Resend**: dominio `conversia.cl` verificado (SPF/DKIM) + `no-reply@conversia.cl` operativo. (Además, sin los fixes B1/A1-A4 el correo sale como TuBot aunque se verifique.)
- [ ] **Flow producción** (+ **Lemon USD** si LATAM día 1, D4 `variantId`): cargar llaves reales en el Super Admin. Sin llaves → cae a Mock.
- [ ] **Meta**: número de producción del tenant Conversia, plantillas aprobadas, webhooks de alta; sembrar `whatsappRateSchedule` (CL service 0,02 @ 2026-10-01), `serviceFreeTierPerNumber`, techos `messagingCapSvc*`, `features.conversationsPerPeriod` por plan.
- [ ] **Tenant proveedor Conversia** operativo con sus **3 agentes publicados** (comercial/implementación/soporte) + confirmar `ASSISTED_SETUP_PROVIDER_ORG_ID`.
- [ ] **Backup off-Railway**: cargar secrets del bucket (R2) en GitHub (hoy RPO real = 24 h, no 6 h).
- [ ] **Monitoreo**: montar BetterStack contra `/health/status` + `/health/fuse` con `MONITOR_TOKEN` (hoy las alertas técnicas dependen de esto).
- [ ] **Prueba de carga** (~50 tenants chicos concurrentes) — pendiente explícito en `RELIABILITY.md`.
- [ ] Confirmar decisiones del dueño: **DTE fuera de alcance**, comportamiento **reactivo de ventana 24 h** (A7), **MFA en true** en prod (F-4).

---

## LISTA EXACTA DE BLOQUEANTES CON FIX (resumen para re-auditoría)

1. **B1** — `platform.controller.ts:907` reset de contraseña: branderizar nombre/link/`from` por `brandOf(org)`.
2. **B2** — `billing.controller.ts:326,232` retornos de Flow de suscripción: usar `brand.webUrl` + `brand.paymentSubjectPrefix`.
3. **B3** — `billing.controller.ts:666` `creditPackage`: acreditar con `UPDATE … SET balance = balance + credits … RETURNING` (atómico).

**Sin bloqueantes abiertos no se lanza.** Tras corregir B1–B3 (y preferiblemente los ALTOS de marca A1–A4 + A5 operador + A6 tests de caja), re-auditar SOLO esos puntos. Las brechas de diseño/producto (A9–A14) son fidelidad al planner: decidir con el dueño cuáles entran al GO y cuáles son post-lanzamiento.

---

## LO QUE ESTÁ BIEN (evidencia de GO — el núcleo es sólido)

- **Aislamiento RLS**: loop dinámico en `setup.sql` cubre TODA tabla con `organization_id` (incl. las nuevas: vertical_templates, support_tickets, cash_ledger, cash_closures, agenda F8). Doble verificador BLOQUEANTE en CI. `buildClientContext` y el contexto de soporte filtran siempre por `organizationId` (sin cruce).
- **ownerContext (F8)**: doble cerrojo — las tools `ownerOnly` ni se exponen al modelo ni se ejecutan sin `ownerContext`; el flag se deriva server-side del teléfono, nunca del texto → **la inyección de prompt ("soy el dueño") no funciona** (con la reserva de que el teléfono del dueño no tiene OTP).
- **Caja F9**: las 8 reglas se cumplen — append-only inmutable a nivel de BD (REVOKE verificado), montos enteros con signo, idempotencia, la IA jamás escribe, cierre inmutable, conciliado vs declarado, alcance operativo, property-test de cuadratura verde.
- **Dinero**: débito de bolsa atómico + W-2 (refund idempotente) + alerta 80%; webhooks Flow/Lemon/Stripe/Getnet con firma validada (timing-safe) + reconsulta de estado + anti-fraude de monto + idempotencia por eventId; grandfathering (locked_price) sellado; setup obligatorio antes de activar.
- **WhatsApp/Meta**: medición por número (1.000 gratis/mes), tarifa por fecha, 4 orígenes de servicio instrumentados, verdad fiscal en `usage_events`, firma HMAC obligatoria (fail-closed), dedup por wamid con triple defensa anti-replay.
- **Marca (núcleo)**: `brandOf`/`brandFromOrigin` caen a tubot; CORS multi-marca; checkout de pago único + catálogo + firma de agenda nativa + registro/login/Google resuelven marca por Origin (nunca del body); **frontend conversia sin "tubot" visible**; regresión TuBot intacta.
- **Producto**: F2 instalación transaccional/idempotente sin datos de Digital-Dent; design system Nocturna fiel en lo esencial (claro/oscuro como tokens, 6 acentos, créditos semánticos 60/85, nav riel/tabs 620, lint anti-apps/web, acento persistido); F7 retoma ticket al reiniciar navegador.
- **Operación**: pool de BD acotado y configurable, concurrencia razonable, backup doble con restore verificado en cada corrida + DR probado (RTO ~5 min), runbook de incidentes bi-marca.
