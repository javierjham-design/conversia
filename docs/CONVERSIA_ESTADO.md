# ESTADO DEL MONTAJE CONVERSIA (actualizar en el PR de cada etapa)

## Decisiones del dueño (resueltas 2026-10-01)

- **D1 — cobro del mensaje de servicio: opción (a).** Conversia cobra el servicio al cliente vía **créditos/bolsa** (`features.serviceDebitsWallet` en planes `conversia_*`), con **exención de los 1.000 gratis/mes por número** (contador de E2). Coherente con el modelo WABA (ver nota abajo). El cobro de **recargas/suscripciones** de Conversia usa **Flow (CLP, mismas credenciales/cuenta de plataforma que TuBot)** + **Lemon Squeezy (USD)**.
- **D2 — overage de conversaciones TuBot: NO se factura al lanzamiento.** Texto veraz (sin prometer cobro); `conversationOverageClp` queda reservado (0).
- **D3 — pago a Meta:** las WABA de Conversia son **nuestras** (con el número del cliente) → **nosotros le pagamos a Meta** directamente y lo recuperamos del cliente vía créditos (D1a). (Distinto de TuBot.)
- **D4 — LATAM día 1: SÍ.** Lemon Squeezy USD (W-3) entra en F5. Cargar producto/`variantId` en LS queda **operativo del dueño** (debe quedar listo y operativo).
- **D5 — máquina de estados de alta: APROBADA** (setup pagado con prefijo `setup:` que NO activa suscripción → `implementing` → activación solo al marcar ENTREGADO; exclusión del trial-lifecycle para brand=conversia).
- **D6 — verificación de correo en el registro: SÍ** (se construye en F3).
- **D7 — camino de alta del cliente vendido por el bot:** pendiente (antes de F6).

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
| E3 | en PR | | 2026-10-01 | OK migración DADO + D2=no facturar overage; migración 2 tablas+índice (aplicar prod = runbook del dueño), cupo + contador atómico + gate svc + fusibles svc separados; TAREA 5 (platform) por SQL (sin OK); verify:isolation lo valida CI (sin BD local) |
| E4 | mergeado | #398 | 2026-10-01 | regla 6 neutra de canal + guarda tope/fusión + prompts TuBot (doc) + plantillas; seed SQL NO regenerado (stale por publicación vía API); métrica "antes" pendiente OK-1 |
| E5 | en PR | | 2026-10-01 | copy veraz (8 ítems) + borradores de aviso (NO enviados) + evento announcement.oct2026 + script con --confirm; 4 textos admin pendientes OK; SQL bot NO regenerado (stale) |
| F1 | en PR | | 2026-10-01 | migración brand+User.settings; brands.ts (brandOf); CORS multi-marca; registro brand-por-Origin + country→currency (H20); PATCH /me/preferences + brand en GET/me (H44); brandOf en correos de pago+retornos Flow, export, firma de agenda (ToolContext.brandName); tests. Barrido FINO pendiente (bajo impacto): asuntos de alerta mailer/channel-auth, descripción de getPlanes, links de platform.controller (zona protegida) |
| F2 | en PR | | 2026-10-01 | motor de paquetes verticales: tabla vertical_templates (org_id nullable, RLS), loaders extraídos de seed.ts a packages/database (compartidos seed+instalador), installVerticalPackage transaccional, endpoints tenant+platform, registro con ?vertical=, rubros dental/barberia + seed v1, verify-isolation case |
| F4 | pendiente | | | agenda nativa completa |
| F5 | en PR | | 2026-10-01 | planes conversia_* (créditos/serviceDebitsWallet/cupo -1) + migración brand en plans + locked_price (grandfathering) + catálogo por marca + pesos walletWeights:conversia + F5-B débito de servicio (exención free tier + refund W-2) + setup:/lifecycle + exclusión trial-lifecycle conversia + GET /billing/wallet/summary + sobre 500 créditos. DIFERIDO: Lemon W-3 (D4, cargar variantId=operativo), activación final=F10, estimador difusiones/textos finos por marca |
| F3 | en PR (Tramo 1) | | 2026-10-01 | apps/conversia-web NUEVA: scaffold Next.js (puerto 3002) + design system Nocturna (tokens oscuro/claro + 6 acentos curados, globals.css) + acento por país (config) + auth login + home "Hoy" (saludo + créditos semánticos de /billing/wallet/summary) + Dockerfile + runbook Railway (DEPLOYMENT.md) + regla ESLint no importar apps/web. PENDIENTE (tramos sig.): bandeja WhatsApp, agenda, clientes, facturación, ajustes, nav unificada, registro visual por vertical, persistir acento vía PATCH /me/preferences, D6 verificación correo |
| F6 | pendiente | | | requiere D7 |
| F7 | pendiente | | | |
| F8 | pendiente | | | |
| F9 | pendiente | | | |
| F10 | pendiente | | | |
| Auditoría pre-prod | pendiente | | | |
