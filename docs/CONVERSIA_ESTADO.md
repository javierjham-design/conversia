# ESTADO DEL MONTAJE CONVERSIA (actualizar en el PR de cada etapa)

## Decisiones del dueño (resueltas 2026-10-01)

- **D1 — cobro del mensaje de servicio: opción (a).** Conversia cobra el servicio al cliente vía **créditos/bolsa** (`features.serviceDebitsWallet` en planes `conversia_*`), con **exención de los 1.000 gratis/mes por número** (contador de E2). Coherente con el modelo WABA (ver nota abajo). El cobro de **recargas/suscripciones** de Conversia usa **Flow (CLP, mismas credenciales/cuenta de plataforma que TuBot)** + **Lemon Squeezy (USD)**.
- **D2 — overage de conversaciones TuBot: NO se factura al lanzamiento.** Texto veraz (sin prometer cobro); `conversationOverageClp` queda reservado (0).
- **D3 — pago a Meta:** las WABA de Conversia son **nuestras** (con el número del cliente) → **nosotros le pagamos a Meta** directamente y lo recuperamos del cliente vía créditos (D1a). (Distinto de TuBot.)
- **D4 — LATAM día 1: SÍ.** Lemon Squeezy USD (W-3) entra en F5. Cargar producto/`variantId` en LS queda **operativo del dueño** (debe quedar listo y operativo).
- **D5 — máquina de estados de alta: APROBADA** (setup pagado con prefijo `setup:` que NO activa suscripción → `implementing` → activación solo al marcar ENTREGADO; exclusión del trial-lifecycle para brand=conversia).
- **D6 — verificación de correo en el registro: SÍ** (se construye en F3).
- **D7 — camino de alta del cliente vendido por el bot:** pendiente (antes de F6).
- **D8 — identidad SEPARADA por marca: APROBADA** (cuentas 100% separadas + super admin separado). El email deja de ser único global y pasa a `@@unique([email, brand])` tanto en `users` como en `platform_admins`. El mismo correo es una cuenta independiente en TuBot y en Conversia; login/registro/Google y el login del super admin resuelven la cuenta por la **marca derivada del Origin** (`brandFromOrigin`, nunca del body). El super admin solo ve/opera los tenants de SU marca (listas, métricas, auditoría y cada acción por-org filtradas por `brand`). Existentes → `tubot` (byte-for-byte).

## Nota crítica — modelo WABA de Conversia (base de todo el cobro de servicio)

Desde el **2026-10-01** rige la nueva forma de cobro de Meta por mensajes de servicio. En **Conversia las cuentas WABA son NUESTRAS** (registradas con el número del cliente), a diferencia de TuBot. Por cada cuenta WABA hay **1.000 mensajes de servicio gratis/mes**; sobre ese umbral **pagamos nosotros a Meta** y lo cobramos al cliente (créditos, D1a).

**CONFIRMADO con Meta (2026-10-01, docs + fuentes técnicas) — cómo funcionan los 1.000:**
- **Por número de teléfono de negocio** (`phone_number_id`), NO por cuenta WABA entera: 3 números = 3×1.000. → el contador de E2 (`serviceFreeTierPerNumber`, key por `phone_number_id`) **ya es correcto en esto**.
- Tras el 1.001.º mensaje ENTREGADO: tarifa **utility/authentication del mercado del DESTINATARIO**, sin descuento por volumen. → `computeWhatsappCostUsd(..., geoFromPhone(toPhone).country)` **ya es correcto**.
- **Reset mensual, SIN roll-over**, corte a las **00:00 en la zona horaria de la WABA** (NO UTC). Reacciones no cuentan; en grupos, 1 por destinatario; se cuenta por mensaje **ENTREGADO** (delivered), no enviado.

**AJUSTE TÉCNICO PENDIENTE (de los hallazgos):** el contador de E2 usa **mes calendario UTC** y cuenta al ENVIAR. Meta usa la **zona horaria de la WABA** y cuenta ENTREGADOS. Para Chile (America/Santiago) el desfase del corte es ~3-4 h. Alinear la ventana del contador a la zona horaria de la WABA (y, si se quiere precisión fina, contar sobre `delivered` del webhook) → se implementa en **F5-B** (donde el débito de servicio por marca exige precisión del free tier). La VERDAD fiscal ya la da `usage_events` (webhook, con `billable`); el contador Redis es estimación.

| Etapa | Estado | PR | Fecha | Notas |
|---|---|---|---|---|
| PR-0 | mergeado | #395 | 2026-10-01 | docs del plan + correcciones H1/H29 a COSTOS + .gitignore |
| E1 | mergeado | #396 | 2026-10-01 | schedule de tarifas por fecha (cimiento); sin tocar flujos de envío ni sembrar BD |
| E2 | mergeado | #397 | 2026-10-01 | medición service_send + W-2 (3 fallos) + free tier por número + N2 reintentos + N3 escalación; SIN frenar envíos. OPERATIVO: sembrar whatsappRateSchedule el día del deploy |
| E3 | EN PROD | | 2026-10-01 | OK migración DADO + D2=no facturar overage; migración 2 tablas+índice (aplicar prod = runbook del dueño), cupo + contador atómico + gate svc + fusibles svc separados; TAREA 5 (platform) por SQL (sin OK); verify:isolation lo valida CI (sin BD local) |
| E4 | mergeado | #398 | 2026-10-01 | regla 6 neutra de canal + guarda tope/fusión + prompts TuBot (doc) + plantillas; seed SQL NO regenerado (stale por publicación vía API); métrica "antes" pendiente OK-1 |
| E5 | EN PROD | | 2026-10-01 | copy veraz (8 ítems) + borradores de aviso (NO enviados) + evento announcement.oct2026 + script con --confirm; 4 textos admin pendientes OK; SQL bot NO regenerado (stale) |
| F1 | EN PROD (#401) | | 2026-10-01 | migración brand+User.settings; brands.ts (brandOf); CORS multi-marca; registro brand-por-Origin + country→currency (H20); PATCH /me/preferences + brand en GET/me (H44); brandOf en correos de pago+retornos Flow, export, firma de agenda (ToolContext.brandName); tests. Barrido FINO pendiente (bajo impacto): asuntos de alerta mailer/channel-auth, descripción de getPlanes, links de platform.controller (zona protegida) |
| F2 | EN PROD (#402) | | 2026-10-01 | motor de paquetes verticales: tabla vertical_templates (org_id nullable, RLS), loaders extraídos de seed.ts a packages/database (compartidos seed+instalador), installVerticalPackage transaccional, endpoints tenant+platform, registro con ?vertical=, rubros dental/barberia + seed v1, verify-isolation case |
| F5 | EN PROD | #403 | 2026-10-01 | planes conversia_* (créditos/serviceDebitsWallet/cupo -1) + brand en plans + locked_price + catálogo por marca + walletWeights:conversia + F5-B débito de servicio + setup:/lifecycle + GET /billing/wallet/summary. DIFERIDO: Lemon W-3 (D4, cargar variantId=operativo) |
| F3 | EN PROD (completo) | #404/#406/#409/#410/#411 | 2026-10-02 | apps/conversia-web LIVE (app.conversia.cl). T1 scaffold+Nocturna; T2 nav unificada; T3 pantallas de cliente (bandeja WhatsApp, clientes, agenda, cobros, ajustes) + acciones de bandeja + crear cita + registro por rubro + QR 2FA; D6 verificación de correo |
| D8 | EN PROD | #407/#408 | 2026-10-01 | identidad separada por marca (`@@unique([email, brand])`); brandFromOrigin; super admin AISLADO por marca; consola de Conversia |
| F4 | EN PROD | #413 | 2026-10-02 | agenda nativa completa + Cobros self-service (Flow) |
| D7 | EN PROD | #414 | 2026-10-02 | autoservicio `/registro?vertical=` preselecciona rubro |
| F6 | EN PROD | #415/#416/#417/#418 | 2026-10-02 | contenido de rubros piloto (dental/barbería/peluquería/estética/centro médico + genérico) + tenant comercial Conversia + catálogo completo de rubros (olas 1-3) |
| Super Admin | EN PROD | #420/#421 | 2026-10-02 | SA-1..SA-5: editar agentes, instalar cualquier rubro, conversaciones, agenda, onboarding, canales |
| F7 | EN PROD | #422 | 2026-10-02 | soporte in-app con hilo persistente + bandeja en la consola |
| F8 | EN PROD | #423 | 2026-10-02 | el dueño administra su agenda por el bot (tools de horarios, modo dueño) |
| Recordatorios | EN PROD | #424 | 2026-10-02 | recordatorios + recaptura (no-show / tratamiento) event-driven |
| F9 | EN PROD | #425 | 2026-10-02 | recaudación y caja: libro append-only inmutable + cierre + conciliación (migración+RLS aplicadas a prod) |
| F10 | EN PR | | 2026-10-02 | consola de operación: rol OPERADOR (denylist centralizada en el guard + MFA obligatorio + gestión de operadores) + buildClientContext para soporte (F7) + marcar ENTREGADO + semáforo de cartera + UI (Operadores, Alta guiada, badge, contexto en soporte). SIN migración (role ya existía). Brechas documentadas: CICLO_VIDA_CLIENTE (offboarding/permanencia/migración de marca/DTE) + INCIDENT bi-marca + SUPER_ADMIN_SECURITY §6. DIFERIDO: permisos finos por sub-acción, step-up TOTP en impersonación |
| Auditoría pre-prod | pendiente | | | ejecutar cuando F10 esté mergeada (GO/NO-GO) |
