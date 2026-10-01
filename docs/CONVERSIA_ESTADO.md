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

**PENDIENTE OPERATIVO (con Meta, no es código):** confirmar **cómo cuenta Meta esos 1.000** y **cuál es la fecha de corte** (¿mes calendario? ¿aniversario de la WABA? ¿ciclo de facturación de la línea?). El contador de E2 usa hoy **mes calendario UTC** (`serviceFreeTierPerNumber`, key por `phone_number_id`); si Meta usa otra ventana, hay que **alinear la ventana del contador** a esa fecha de corte (ajuste técnico en F5-B o corrección a E2). De esto depende saber **exactamente cuándo empezamos a pagar** cada mes.

| Etapa | Estado | PR | Fecha | Notas |
|---|---|---|---|---|
| PR-0 | mergeado | #395 | 2026-10-01 | docs del plan + correcciones H1/H29 a COSTOS + .gitignore |
| E1 | mergeado | #396 | 2026-10-01 | schedule de tarifas por fecha (cimiento); sin tocar flujos de envío ni sembrar BD |
| E2 | mergeado | #397 | 2026-10-01 | medición service_send + W-2 (3 fallos) + free tier por número + N2 reintentos + N3 escalación; SIN frenar envíos. OPERATIVO: sembrar whatsappRateSchedule el día del deploy |
| E3 | en PR | | 2026-10-01 | OK migración DADO + D2=no facturar overage; migración 2 tablas+índice (aplicar prod = runbook del dueño), cupo + contador atómico + gate svc + fusibles svc separados; TAREA 5 (platform) por SQL (sin OK); verify:isolation lo valida CI (sin BD local) |
| E4 | mergeado | #398 | 2026-10-01 | regla 6 neutra de canal + guarda tope/fusión + prompts TuBot (doc) + plantillas; seed SQL NO regenerado (stale por publicación vía API); métrica "antes" pendiente OK-1 |
| E5 | pendiente | | | copy veraz + avisos (tras E3) |
| F1 | pendiente | | | backend brand-aware (prereq de F5) |
| F2 | pendiente | | | motor de paquetes verticales |
| F4 | pendiente | | | agenda nativa completa |
| F5 | pendiente | | | D1/D4/D5 resueltas; requiere F1 (ideal F2); lleva migración (locked price + serviceDebitsWallet) |
| F3 | pendiente | | | D6=verificación correo SÍ; requiere F1,F2,F5; deploy Railway = dueño |
| F6 | pendiente | | | requiere D7 |
| F7 | pendiente | | | |
| F8 | pendiente | | | |
| F9 | pendiente | | | |
| F10 | pendiente | | | |
| Auditoría pre-prod | pendiente | | | |
