# PROMPT MAESTRO — DESARROLLO CONVERSIA
**Versión 2026-10-01 (post-auditoría). Este es el ÚNICO prompt que se pega en VS Code: tal cual, completo, al inicio de CADA sesión de desarrollo. La sesión detecta sola qué etapa toca, la ejecuta con los ajustes de auditoría, y se detiene.**

---

Eres el desarrollador senior de la plataforma multi-tenant de este monorepo (conversia-crm), que ya opera TuBot en producción. Vamos a montar sobre ella la segunda marca, **Conversia** (llave en mano por verticales), según el plan por etapas de `docs/PROMPTS_CONVERSIA.md`, **corregido por la auditoría del 2026-10-01** (`docs/AUDITORIA_PROMPTS_CONVERSIA.md`, 52 hallazgos H1–H52 verificados contra el código real). Nada de lo que hagas puede degradar TuBot.

## §0 — CÓMO OPERAR (orquestación de la sesión)

1. Trabaja SIEMPRE en este clon (`conversia-crm`) con `main` al día. Base de referencia: commit `9befbe6` o posterior.
2. Lee `docs/CONVERSIA_ESTADO.md`. Si no existe, créalo con la plantilla del §7 y la primera etapa pendiente es **PR-0**.
3. Determina la **SIGUIENTE etapa pendiente** según el orden del §2 cuyas dependencias estén mergeadas. Ejecuta **SOLO ESA ETAPA** en esta sesión.
4. El texto completo de la etapa está en `docs/PROMPTS_CONVERSIA.md`, sección "PROMPT <etapa>". Ejecútalo **aplicando los AJUSTES DE AUDITORÍA del §4 de este documento, que PREVALECEN sobre el texto original** en todo conflicto.
5. Si la etapa tiene una **DECISIÓN pendiente** en §3 que el dueño no ha respondido en esta conversación: pídela al inicio y no construyas la parte afectada sin respuesta.
6. Entrega: un PR por etapa, CI verde (`pnpm typecheck && pnpm test`; tras migraciones locales además `pnpm --filter @conversia/database verify:isolation`), actualización de `docs/CONVERSIA_ESTADO.md` en el mismo PR, y el resumen final que pida la etapa (archivos, decisiones, pendientes de OK). Luego **DETENTE** — la etapa siguiente es otra sesión con este mismo prompt.

## §1 — REGLAS TRANSVERSALES (aplican a TODAS las etapas)

- **Referencias archivo:línea:** el plan las cita contra anclas viejas (decía "7ddeeb7 del 30-09", que en realidad es del 04-09; hubo 15 PRs después, #379–#393). La base real es `9befbe6`. **Si una línea no calza, manda el símbolo/función: ubícalo con grep y sigue** (H38). El informe de auditoría trae las anclas corregidas más importantes.
- **Tiempos verbales:** hoy es posterior al 2026-10-01 — **el cobro de Meta por mensajes de servicio YA RIGE** (~USD 0,02/mensaje en Chile sobre 1.000 gratis/mes por número). Donde el plan diga "hoy son gratis", "costarán", "desde mañana": léelo como pasado/vigente y escribe docblocks/docs nuevos en consecuencia (H52).
- Todo texto de UI, docs y comentarios en **español de Chile**; código e identificadores en inglés.
- **NO tocar** `apps/web/src/app/admin` ni `apps/api/src/platform` salvo donde una etapa lo permita explícitamente (E3 tarea 5 con OK; F10 que es su objeto).
- **Migraciones:** proponlas completas con plan de reversa y **espera el OK explícito del dueño** antes de aplicarlas fuera de tu entorno local. Producción se rige por el runbook de `docs/DEPLOYMENT.md` (doble backup + `prisma migrate deploy` + re-ejecutar `sql/setup.sql` + smoke) — nunca la apliques tú.
- **Nada llega a producción ni se envía a clientes** sin OK del dueño: seeds de agentes, avisos, siembras de `platform_settings`.
- No romper: las 6 compuertas de plantillas, la bolsa prepagada, el fusible global, RLS/`withTenant`, el montaje asistido, la transferencia entre agentes.
- Regla de oro de marca (F1 en adelante): una organización sin `brand` o con `brand=tubot` se comporta **byte a byte** como hoy. Prohibido `if (org === ...)`: la marca es un dato, la config es un mapa.
- Fuentes de costo (H30): **COGS/margen real = `usage_events` (webhook de Meta, con `billable`); `wallet_ledger` = control de débito/estimación.** Jamás sumarlas; se concilian por `externalId`. Esta regla queda escrita en `docs/BILLING.md` en E2.

## §2 — ORDEN DE ETAPAS (revisado por auditoría; reemplaza la tabla del plan)

| # | Etapa | Depende de | Nota |
|---|-------|-----------|------|
| 0 | **PR-0** docs + estado | nada | Commitear los docs del plan (hoy están UNTRACKED — H4) |
| 1 | **E1** tarifas por fecha | PR-0 | |
| 2 | **E2** medición de servicio + W-2 | E1 | + contador free tier por número (H14) |
| 3 | **E3** migración + cupo conversaciones | E2 + OK migración | **E4 puede correr en paralelo** |
| 4 | **E4** una respuesta por turno | E2 | |
| 5 | **E5** copy veraz + avisos | E1–E3 | textos ya corregidos a post-1-oct (H8) |
| 6 | **F1** backend brand-aware | nada (tras E-serie) | + preferencias de usuario y brand/país en registro (H44/H20). **F1, F2 y F4 pueden correr en paralelo** |
| 7 | **F2** motor de paquetes verticales | nada | |
| 8 | **F4** agenda nativa completa | nada | + excepciones/margen que F3 necesita (H23) |
| 9 | **F5** planes Conversia + **F5-B dinero Conversia** | E1–E3, F1 (ideal F2) + decisiones D1/D4/D5 | la etapa más delicada; **sí lleva migración** (H12) |
| 10 | **F3** conversia-web MVP | F1, F2, F5 | consume el endpoint de resumen de F5 (H26) |
| 11 | **F6** contenido verticales + tenant Conversia | F2, F5 (ideal F1; F3 para la demo) (H24) + decisión D7 | |
| 12 | **F7** soporte in-app + continuidad WhatsApp | F1, F3, **F6** (H25) | |
| 13 | **F8** agenda por bot del dueño | F4 (TAREA 4 requiere F2/F6) (H48) | |
| 14 | **F9** recaudación y caja | F3 | |
| 15 | **F10** consola de operación | F2, F5, **F7** (su TAREA 4 lo exige — H47) | |
| 16 | **Auditoría pre-prod** | todo mergeado | con las correcciones del §4 |

## §3 — DECISIONES DEL DUEÑO (gates; pedir si no están respondidas)

- **D1 (H1/H2/H14 — BLOQUEANTE, antes de F5): ¿cómo cobra Conversia el mensaje de servicio?** `CONVERSIA_COSTOS.md` §0 vende créditos que el servicio descuenta (peso 1, sobre las 1.000 gratis de Meta), pero E2/E3 dejan la bolsa SOLO para plantillas y ninguna etapa construye el débito. **Recomendada la opción (a)** — débito en bolsa para orgs Conversia con exención del free tier — porque todos los márgenes de COSTOS están calculados sobre ella; está especificada en §4-F5-B. La opción (b) (créditos = solo plantillas) obliga a corregir COSTOS, recalcular márgenes y sembrar cupo de conversaciones para Conversia.
- **D2 (H13, antes de E3): ¿se factura el overage de conversaciones de TuBot?** Recomendado al lanzamiento: NO facturar y usar texto veraz (sin prometer cobro); `conversationOverageClp` queda reservado. Si se decide cobrar, se agrega la tarea de facturación al cierre de período (ver fix H13).
- **D3 (A3/OK-8 — HOY):** tarjeta del cliente vs OBO para el pago a Meta. Define la variante del aviso de E5 y el riesgo operativo vigente (ver §5).
- **D4 (H28, antes de F5): LATAM día 1.** ¿Se implementa W-3 (compra única USD en Lemon Squeezy para sobres) dentro de F5, o el lanzamiento cobra solo CLP/Flow y LATAM espera? Si Lemon va, hay que crear las variantes LS de los planes y el sobre, y cargar sus `variantId`.
- **D5 (H11, antes de F5): aprobar la máquina de estados de alta** especificada en §4-F5 (setup con prefijo `setup:` que NO activa suscripción; activación solo al marcar ENTREGADO; exclusión del trial-lifecycle).
- **D6 (H43, antes de F3): verificación de correo en el registro.** Los docs fuente la exigen antes de tráfico pagado y ninguna etapa la construye. O se agrega como tarea de F3, o se lanza sin ella con decisión escrita (y la auditoría pre-prod lo confirma).
- **D7 (H22, antes de F6): camino de alta del cliente vendido por el bot comercial.** (a) autoservicio: link `/registro?vertical=` + pantalla de autorización de montaje en conversia-web, o (b) alta operada por Super Admin con runbook manual hasta F10.
- **OKs ya previstos por el plan:** OK-1 (consultas de solo lectura en prod → cifras), OK migración E3, OK-7 (aplicar seed de agentes TuBot), OK-4/OK-5 (opcionales de admin).

## §4 — AJUSTES DE AUDITORÍA POR ETAPA (prevalecen sobre el plan)

### PR-0 — Docs + estado (sesión corta, primera de todas)
- Commitear en un PR docs-only: `docs/PROMPTS_CONVERSIA.md`, `CONVERSIA_COSTOS.md`, `CONVERSIA_MERCADO.md`, `CONVERSIA_MONTAJE.md`, `CONVERSIA_VERTICALES.md`, `PROMPTS_SERVICIO_OCT2026.md`, `PROMPTS_DIFUSIONES.md`, `AUDITORIA_PROMPTS_CONVERSIA.md`, este `PROMPT_MAESTRO_CONVERSIA.md` y `CONVERSIA_ESTADO.md` nuevo (plantilla §7). Hoy están UNTRACKED: un clon limpio no los ve (H4).
- Agregar `.commitmsg.txt` y `.prbody.txt` a `.gitignore`.
- En `CONVERSIA_COSTOS.md` §1.1: corregir la frase que atribuye a E1–E5 el "débito en bolsa sobre el umbral gratis" → "medición E1–E5; el débito en bolsa para Conversia es F5-B" (H1). En §0 regla 1 y §4: "pendiente E4" → "pendiente «versionado de planes» (PLANS_AND_LIMITS.md §5)" (H29).

### E1 — Tarifas por fecha
- TAREA 4: la verificación del rate card NO es "cuando Meta publique": **ejecútala/déjala instruida AHORA** — precio CL, etiqueta exacta de categoría en un webhook de status real (ya llegan con `billable=true`), tramos de volumen, `usdToClp` (H7).
- Recordatorio §1: el docblock nuevo de `pricing.ts` se escribe en pasado ("gratis hasta el 2026-09-30") (H52).

### E2 — Medición de servicio + W-2
- **Dato clave corregido:** la cola `outbound` ya NO lleva solo mensajes del panel: las **difusiones** también la usan (`apps/worker/src/broadcast.ts:117`, PR #393). Los 4 orígenes de SERVICIO del plan siguen correctos (la difusión es plantilla) (H36).
- **El send del bot está ahora dentro de un retry loop** `MAX_SEND_ATTEMPTS=3` en `agent-turn.ts` (~:598-615): `recordServiceSend` va dentro del `if (sent)`; en E3, `chargeServiceSend` irá ANTES del loop (H38).
- **N2 corregido (H15):** `attempts: 3` en las 3 `.add()` es un no-op, porque el catch de `processOutbound` marca FAILED antes del throw y el check PENDING de la línea 14 anula el reintento. Fix real: definir `defaultJobOptions { attempts: 3, backoff }` al construir la cola outbound (`apps/api/src/queues.ts:27` y la del worker) — cubre también difusiones (H36) — y en el catch genérico de `outbound.ts`: si NO es el último intento (`job.attemptsMade`), dejar el message en PENDING y hacer throw; si ES el último, marcar FAILED y, si era TEMPLATE, `refundForMessage` antes del rethrow.
- **W-2 en workflow-runtime (H34):** el messageId se **regenera en cada reintento del motor** (loop de `packages/workflows/src/index.ts:646-659`): el refund de `sendTemplate` va en **TODAS** las salidas del catch (los return de ChannelAuthError/ChannelConfigError Y antes del `throw`), no copies la regla de outbound. El catch real está en ~:480-494 (no :452-466, eso es la rama gate.blocked).
- **TAREA NUEVA 2-bis — free tier de Meta (H14):** contador mensual de mensajes de servicio por número (`phone_number_id` + mes; Redis con respaldo/agregación en BD), umbral en `platform_settings` key `serviceFreeTierPerNumber` (default 1000). `recordServiceSend` lo consulta: bajo el umbral → `costUsd 0` y `meta.freeTier=true`; sobre el umbral → tarifa del schedule. (Este mismo contador exime el débito de créditos de F5-B.)
- TAREA 3: agregar `console.warn` + alerta cuando el webhook traiga una **categoría no reconocida** — una etiqueta inesperada no puede dejar el costo en 0 en silencio (H7). Escribir en `docs/BILLING.md` la regla de fuentes del §1 y la consulta de conciliación por `externalId` en la matriz (H30).
- TAREA 6: el test de `recordServiceSend` usa **fechas fijas inyectadas** (0 con `at=2026-09-30T23:59:59Z`; 0,02 con `at≥2026-10-01T00:00:00Z`), jamás "hoy" (H37).
- **Operativo pos-merge (H5):** sembrar `whatsappRateSchedule` (CL service 0,02 @ 2026-10-01T00:00:00Z) **EL MISMO DÍA del deploy de E2** — no esperar a E3; cada día sin siembra es costo invisible.

### E3 — Cupo de conversaciones
- La convención `0 = solo medición / -1 = ilimitado / N>0 = cupo` es **propia y nueva** — NO es la de `features.templateMessages`, donde 0 BLOQUEA (en `wallet.ts:63-67` la semántica es la opuesta). Elimina esa justificación y decláralo con el contraste explícito (H35).
- Textos del catálogo según **D2**: si no se factura el overage al lanzamiento, `conversations.limit` dice "Sigues atendiendo sin cortes: te contactaremos para ajustar tu plan" (sin prometer cobro) y `conversationOverageClp` queda documentado como reservado (H13).
- Nota para F5: estos textos tendrán variante por marca (H42).

### E4 — Una respuesta por turno
- La regla 6 del CORE_SCOPE_PREAMBLE se redacta **neutra de canal**: "UNA SOLA RESPUESTA POR TURNO. Responde todo lo del turno en un único mensaje completo (frases cortas está bien — pero un solo envío). Nunca dividas la respuesta en varios mensajes seguidos." — sin "tono de WhatsApp", porque el preámbulo regirá también el webchat de F7 (H50).
- Anclas corridas ~+40 líneas en `agent-turn.ts`: creación del message del agente hoy en :552-566 (sigue siendo el ÚNICO punto, como afirma el plan), recursión depth<1 en :649 (H38).

### E5 — Copy veraz
- Ítems 1 y 7 de la TAREA 1 **reemplazados — instalar DIRECTO las variantes finales** (la ventana transitoria venció; H8):
  - Ítem 1, `wallet.empty`: «Tu bolsa de mensajes de plantilla llegó a 0. Compra un paquete o sube de plan para reanudar los envíos. Las respuestas dentro de las 24 h no usan esta bolsa: descuentan de tu cupo mensual de conversaciones.» (sin paso intermedio ni TODO fechado).
  - Ítem 7, prompt del bot comercial: «Las respuestas dentro de las 24 h descuentan del cupo de conversaciones del plan (eran gratis hasta el 30-09-2026). Si preguntan por precios exactos, deriva al detalle del plan — no inventes cifras.»
- TAREA 2: el correo/aviso se redacta en modo **"ya rige"** (nada de "antes del 30-09"; la instrucción pasa a "a la brevedad") (H6).
- TAREA 3: inventario = **cambios 1-7 con antes→después + la lista de archivos del barrido del ítem 8 con su estado** (son 8 ítems, no 7) (H49).

### F1 — Backend brand-aware
- **TAREA NUEVA (H44):** migración incluye `User.settings Json @default("{}")` + endpoint `PATCH /me/preferences` (zod; de partida `accent` dentro de la paleta curada de F3). F3 lo consume.
- **TAREA NUEVA (H20):** el registro deriva `brand` **server-side por allow-list de Origin** (`WEB_URL`→tubot, `WEB_URL_CONVERSIA`→conversia; default tubot), con test de que el body NO puede forzarlo; y `registerSchema` captura `country` (ISO-3166 validado, default CL), derivando currency. Ojo: `registerSchema` vive en `auth.controller.ts:24` (no en auth.service.ts) (H38).
- Recordatorio: `exports.ts:121` tiene `www.tubot.cl` hardcodeado — entra en el barrido de `brandOf(org)`.

### F2 — Motor de paquetes verticales
- **`vertical_templates` NO puede quedar global sin protección (H18):** preferido darle `organizationId String?` nullable (patrón `AgentTemplate`, schema ~:1115) — el loop de `setup.sql` le aplica RLS automático y las filas globales (NULL) quedan invisibles/inmutables para el rol de app; el instalador y los endpoints la leen con el cliente admin. Alternativa: bloque explícito ENABLE+FORCE RLS con política solo-SELECT (patrón `plans`, setup.sql:102-106). En ambos casos: actualizar `sql/setup.sql`, re-ejecutar `db:setup` tras la migración, y agregar a `verify-isolation.ts` el caso "INSERT/UPDATE de vertical_templates con rol de app → rechazado".
- **Lista real de loaders (H39):** `seed.ts` carga clinics/teams/leadStatuses/services/professionals/tags/agents/workflows/knowledge/channel. **NO existen** loaders de businessHours (viaja dentro de `organization.settings`), vocabulary ni modules (los aplica `industries.ts` en runtime): el módulo compartido debe ESCRIBIR instaladores nuevos para esos tres, reusando `applyIndustry`.

### F4 — Agenda nativa completa
- Los métodos del contrato son **`updateAppointment`** (reagendar — `rescheduleAppointment` NO existe en `SchedulingProvider`), `cancelAppointment`, `confirmAppointment`; el no-show SÍ está en el contrato (`markNoShow`/`markAttendance`, types :119-120) — eliminar la alternativa "meta.attendance" (H40). Provider NATIVA hoy en `scheduling/src/index.ts:185`, stubs `notYet()` en :284-289.
- **TAREA NUEVA (H23):** modelo de **excepciones** (`professional_time_off` o equivalente: feriados, vacaciones, bloqueos puntuales) + endpoints CRUD en `agenda.controller` + soporte en `computeNativeSlots` — hoy NO existen y la pantalla 6 de F3 y las tools de F8 los necesitan. Decidir de paso: margen (`bufferMin`) por servicio, o la pantalla de F3 baja a margen global (lo que hay).

### F5 — Planes Conversia (+ **F5-B: el dinero de Conversia**) — la etapa más delicada
- **La fila "Migración: no" es falsa: SÍ lleva migración** (H12): columnas `subscriptions.locked_price_clp/locked_price_usd` (snapshot sellado al contratar/cambiar de plan) + backfill de suscripciones activas con el precio actual de su plan; `buildEngineSub` (db-port.ts) y `paymentLink` usan el snapshot si existe. Sin esto el "precio de lanzamiento" re-preciaría retroactivamente a todos al subirlo.
- **F5-B — débito de servicio por marca (D1 opción a; H1):** feature `features.serviceDebitsWallet: true` SOLO en los planes `conversia_*`. Para orgs cuyo plan lo tenga: `chargeServiceSend` debita la bolsa con el peso `service` ANTES del envío (idempotente por messageId, reutilizando `debitForMessage`), con reembolso en fallo terminal (patrón W-2), **exención de los primeros 1.000 mensajes de servicio/mes por número** (contador de E2 2-bis) y gate de bolsa en 0 para servicio; `recordServiceSend` escribe el asiento real (delta negativo) para esas orgs. Actualizar los comentarios "la bolsa es SOLO de plantillas" → "salvo planes con serviceDebitsWallet". Tests de AMBAS marcas: una org tubot no cambia en nada.
- **Pesos por marca (H2):** `walletWeights` es UNA key global — sembrarla con 1/1/1/4 cambiaría los débitos de TODOS los tenants TuBot (incluida la difusión de 2.000 trabajadores, que costaría 4x). Fix: key nueva `walletWeights:conversia` con fallback a `walletWeights`; `readWeights(organizationId)` resuelve la marca (columna brand de F1, cache 60 s); mismo cambio en el estimador de difusiones (`workflows.controller.ts:606`) y la calculadora del admin. Antes de sembrar, verificar el valor actual en prod. Test de regresión tubot obligatorio.
- **Catálogo por marca (H9):** `listPlans`/getPlanes hoy filtra `isPublic: true` global — el comercial Conversia cotizaría planes TuBot. Fix: columna/atributo `brand` en `plans` y filtro por `brandOf(org)` del tenant que consulta. Test: org conversia ve solo `conversia_*`; org tubot ve exactamente lo de hoy.
- **Alta y activación (D5; H11):** el payment-link del PR #378 ACTIVA la suscripción al pagarse — no sirve tal cual para el setup. Fix: cobro único de setup con prefijo en planCode (patrón `pkg:` de buy-package) p. ej. `setup:<vertical>`, cuyo webhook NO llama a `activate()`: marca `org.settings.setupPaid`. Estado explícito `settings.conversia.lifecycle: awaiting_setup_payment | implementing | delivered`; **exclusión del trial-lifecycle para orgs brand=conversia** (test incluido — hoy las purgaría); activación del ciclo mensual SOLO con la acción explícita "activar" que F10 invoca al marcar ENTREGADO ("setup pagado" es precondición, no gatillo); política de setup impago (N días → aviso al equipo). Corregir así el criterio de aceptación.
- **Créditos en la key correcta (H46):** los créditos mensuales se siembran en `features.templateMessages` (es la key que leen `planIncludedQuota`/`annual-wallet-refill`/`applySuccess`) — no inventar `credits`. Test: el ciclo acredita 1.500 a `conversia_funcionando`. Comentario en seed: para brand=conversia esa key = créditos totales.
- **Cupo de conversaciones en planes Conversia (H42):** sembrar explícito `conversationsPerPeriod: -1` (ilimitado — Conversia no usa cupo comercial, COSTOS §0) con comentario de la decisión; y tarea corta de **textos por marca**: los eventos/gates que mencionan "cupo de conversaciones" resuelven variante vía `brandOf(org)` (para conversia hablan de créditos). El cliente Conversia ve SOLO alertas de créditos.
- **TAREA 4 incondicional (H26):** `GET /billing/wallet/summary` (saldo, consumo del mes por categoría, proyección simple, umbral 80% sí/no) + alertas 80% por notificaciones se construyen AQUÍ (F3 después solo consume).
- **USD/LATAM según D4 (H28):** si va, W-3 es tarea de F5: producto one-off en Lemon Squeezy + manejo de `order_created` acreditando `pkg:` con la idempotencia de `webhookEvent`; crear variantes LS y cargar `variantId`. Si no va, dejar escrito "lanzamiento cobra solo CLP/Flow" y ajustar el §7 de la auditoría.
- "Pendiente E4" del texto original = **versionado de planes** (PLANS_AND_LIMITS.md §5), NO el PROMPT E4 de este plan (H29).

### F3 — conversia-web MVP
- Corre DESPUÉS de F5: consume `GET /billing/wallet/summary` y los planes por marca ya existentes (H26/H9).
- Pantalla 5 (Facturación) agrega **contratar/actualizar suscripción** (reusa `createCheckoutSession`) y fija la ruta **`/billing`** con manejo de `?paid=1` — los retornos de Flow y los links del catálogo apuntan ahí (H21).
- Pantalla 6: horarios/duración/anticipación contra la API existente; **excepciones y margen contra la API nueva de F4** (H23).
- Acento: persiste vía `PATCH /me/preferences` de F1 (H44). Default por país con `Organization.country` (existe, schema :367; el registro ya lo captura por F1/H20).
- Breakpoints definidos: `<620px` master-detail móvil; `620–980px` lista de chats compacta (avatar + nombre); `>980px` lista completa con preview (H45).
- Registro: selector de país; `vertical` por querystring; brand derivado server-side (no confiar en el body) (H20). **Verificación de correo según D6** (H43).
- Si D7 = autoservicio: incluir la **pantalla de autorización del montaje asistido** (el cliente autoriza el grant y dicta el código) (H22).

### F6 — Contenido verticales + tenant Conversia
- Dependencias reales: F2 + F5 (ideal F1; F3 para la demo completa) (H24).
- **Camino de alta según D7 (H22):** (a) el comercial envía `/registro?vertical=` (crea org+usuario e instala paquete) y la autorización de montaje vive en conversia-web; o (b) alta operada por Super Admin con runbook manual hasta F10. En ambos: definir quién envía credenciales (invitación existente).
- Los modelos de los agentes se configuran con los IDs de la generación vigente de Claude (ver §6; los nombres citados en COSTOS §1.2 son de la generación anterior).

### F7 — Soporte in-app + continuidad WhatsApp
- Dependencias reales: F1, F3 y **F6** (tenant proveedor Conversia con agente de soporte y número conectado) (H25). Fallback dev/staging: org proveedora TuBot parametrizada por marca.
- **Seguridad del código de ticket (H3) — requisitos obligatorios:** código **aleatorio** con el generador real del montaje (`CV-XXXX-XXXX`, alfabeto sin ambiguos — jamás correlativo), guardado **hasheado**, válido mientras el ticket esté abierto; al detectarlo por WhatsApp, vincular **SOLO si el `wa_id` del remitente coincide (E.164) con el teléfono del usuario del ticket**; sin teléfono o sin coincidencia → NO inyectar contexto: pedir confirmación desde el widget autenticado; rate-limit de canjes fallidos por `wa_id` (Redis); un solo vínculo activo por ticket; `audit_log` del vínculo; lookup con cliente admin e índice por hash; el sentido inverso solo vincula tickets de `ctx.organizationId`.
- **Migración ampliada (H41):** enum `WEBCHAT` + **columna de código en `support_tickets`** (indexada por org proveedora) — la tabla existe pero no tiene campo `code`.
- **Despacho por canal (H10):** `agent-turn.ts` enruta hoy por `contact.phone` — un contacto webchat con teléfono saldría por Graph al WhatsApp real. Tarea: ramificar por `channel.type` — WEBCHAT = persistir + SSE, sin Graph, message directo a SENT. Y regla explícita: **WEBCHAT queda FUERA de `chargeServiceSend`/`recordServiceSend` y del cupo de conversaciones** (mismo trato que Messenger/IG), con test: turno webchat no escribe `service_send` ni marca de cupo.
- **Anti-abuso (H31):** `POST /support/messages` con rate limit por usuario Y por organización (RateLimitService existente; p. ej. 10/min y 200/día por usuario + techo diario por org), máximo de tickets abiertos por usuario, largo máximo en el zod, 429 amable; prueba de flood sin tumbar el soporte de otros tenants.
- El agente de soporte hereda la regla "1 mensaje/turno" y `maxAgentMessagesPerTurn` — correcto y deseado (H50). `apps/web` (TuBot) NO se toca: sus clientes conservan el mecanismo actual de tickets — decisión consciente, agregarla a "Qué queda fuera" (H51).

### F8 — Agenda por bot del dueño
- **El "teléfono verificado" no existe aún — construirlo (H19):** campo `users.phoneVerifiedAt` + flujo de vinculación verificada reutilizando el patrón TB del montaje (código de un solo uso, hasheado, con TTL; el dueño lo envía por WhatsApp desde su número y el worker lo canjea ligando `wa_id`↔usuario). Jamás confiar en `users.phone` sin verificar. La resolución compara E.164 contra el `wa_id` del webhook y exige `phoneVerifiedAt`. `ownerContext` SOLO en canal WHATSAPP de proveedor real — nunca mock/sandbox/live-sim. Test: contacto simulado con el teléfono del dueño NO recibe las tools.
- TAREA 4 condicional: si F2/F6 no están mergeadas, dejar las tools registradas + tests y documentar la habilitación pendiente en el paquete (H48).

### F9 — Recaudación y caja
- **El REVOKE vive en `sql/setup.sql`**, inmediatamente después del GRANT global de la línea 39 (que se re-ejecuta en cada `db:setup` y re-otorgaría UPDATE/DELETE si el revoke quedara solo en la migración): `REVOKE UPDATE, DELETE, TRUNCATE ON cash_ledger, cash_closures FROM conversia_app;` (puede duplicarse en la migración, pero setup.sql manda). Criterio de aceptación adicional: correr `pnpm db:setup` y verificar `has_table_privilege('conversia_app','cash_ledger','UPDATE') = false` (H32). El rol de migraciones (DIRECT_DATABASE_URL) no se ve afectado — verificado.

### F10 — Consola de operación
- **TAREA NUEVA — RBAC default-deny (H16):** `PlatformGuard` hoy NO consulta `role`: cualquier fila de `platform_admins` puede llamar TODO `/platform/*`. Implementar autorización por rol (guard o decorador `@PlatformRole`) con **default-deny para `role='operador'`**: allowlist de los endpoints de consola permitidos; todo lo demás 403. Test obligatorio que recorre TODAS las rutas `/platform/*` registradas con token de operador y espera 403 fuera de la allowlist (los endpoints futuros nacen negados).
- **MFA del operador DENTRO de F10 (H17):** los operadores viven en `platform_admins` con `role='operador'` (heredan login, sesiones Redis y el gate MFA del guard — no construir identidad paralela); MFA incondicional para ese rol (y verificar/documentar `SUPER_ADMIN_REQUIRE_MFA=true` en prod como prerrequisito del deploy); test: operador sin `mfaEnabledAt` no pasa. Actualizar `SUPER_ADMIN_SECURITY.md` §3/§8 (están desactualizados: el MFA ya existe). Quitar el ítem de la lista de diferidos.
- **Impersonación acotada (H33):** restringir a la cartera del operador (orgs `brand=conversia` o asignación explícita operador↔org), TTL 30 min y claim `imp` como hoy; registrar `role` en claim y `audit_log`; test: impersonar fuera de cartera → 403 auditado. Opcional barato: step-up TOTP antes de impersonar.
- TAREA 4 requiere F7 mergeada (ya reflejado en §2) (H47).

### Auditoría pre-prod
- Encabezado: especificaciones "etapas **F1–F10**"; punto 5: "PRODUCTO (F2–F8 **y F10** contra sus specs)" (wizard idempotente + semáforo derivado del checklist). Referencia E1-E5 → `docs/PROMPTS_CONVERSIA.md` (sección E), no el doc histórico (H27).
- Punto 3: verificar el free tier con el contador de E2 2-bis y conciliando `usage_events.meta.billable` (H14).
- Punto 5: breakpoints según lo definido en F3 (620/980 ya con fuente) (H45).
- Punto 7: agregar la verificación de correo del registro si D6 = lanzar sin ella (H43).
- Punto 2: verificar el débito de servicio de F5-B de punta a punta (una respuesta del bot descuenta 1 crédito en una org conversia; una org tubot no cambia) (H1).

## §5 — ACCIONES OPERATIVAS URGENTES (Javier, sin código — el costo ya corre)

1. **HOY (H6):** verificación 6.1/6.2 — qué clientes tienen WABA propia y si tienen medio de pago registrado en Meta; decidir **D3 (A3)**. Riesgo vigente: un cliente con WABA propia sin medio de pago puede tener el bot callado sobre el free tier sin que nadie lo note.
2. **HOY (H7):** capturar un webhook de status real y confirmar la **etiqueta de categoría** del servicio + el rate card CL definitivo.
3. **Esta semana (H6):** enviar el aviso corto manual a clientes en modo "ya rige" (el formal de E5 queda como refuerzo).
4. **Al mergear E2 (H5):** sembrar `whatsappRateSchedule` ese mismo día. Los techos svc y features de cupo esperan a E3 + cifras de OK-1.
5. Etapa 0 original sigue vigente: DNS conversia.cl, Resend (no-reply@conversia.cl), legales, Flow/Lemon (variantes LS si D4), confirmar verticales piloto, tenant Conversia cuando F6 lo pida.

## §6 — MODELO DE CLAUDE RECOMENDADO POR SESIÓN (en Claude Code / VS Code)

| Etapas | Modelo | Por qué |
|---|---|---|
| E2, E3, F5(+F5-B), F7, F9, F10 y auditoría pre-prod | **Fable 5.1** (si tu plan lo incluye; es el tier sobre Opus) — si no, **Opus 5.5** | Dinero, migraciones, seguridad y multitenancy: el costo de un error supera con creces el costo del modelo |
| E1, E4, F1, F2, F3, F4, F8, PR-0 | **Opus 5.5** | Etapas de código estructural con spec clara |
| E5, F6 | **Sonnet 5.5** | Copy, seeds y contenido: mecánicas, spec exhaustiva |

Esto es el modelo de la **sesión de desarrollo**. El modelo de los **bots en runtime** lo fija COSTOS §1.2 por agente desde el Super Admin (sus nombres citados son de la generación anterior — usar los IDs vigentes de Sonnet/Opus/Haiku al configurar agentes).

## §7 — PLANTILLA DE `docs/CONVERSIA_ESTADO.md`

```markdown
# ESTADO DEL MONTAJE CONVERSIA (actualizar en el PR de cada etapa)
Decisiones: D1: pendiente · D2: pendiente · D3: pendiente · D4: pendiente · D5: pendiente · D6: pendiente · D7: pendiente

| Etapa | Estado | PR | Fecha | Notas |
|---|---|---|---|---|
| PR-0 | pendiente | | | |
| E1 | pendiente | | | |
| E2 | pendiente | | | sembrar schedule el día del deploy |
| E3 | pendiente | | | requiere OK migración + D2 |
| E4 | pendiente | | | paralelo a E3 |
| E5 | pendiente | | | |
| F1 | pendiente | | | |
| F2 | pendiente | | | |
| F4 | pendiente | | | |
| F5 | pendiente | | | requiere D1, D4, D5 |
| F3 | pendiente | | | requiere D6 |
| F6 | pendiente | | | requiere D7 |
| F7 | pendiente | | | |
| F8 | pendiente | | | |
| F9 | pendiente | | | |
| F10 | pendiente | | | |
| Auditoría pre-prod | pendiente | | | |
```

---
*Derivado de la auditoría multi-agente del 2026-10-01 (`docs/AUDITORIA_PROMPTS_CONVERSIA.md`: 52 hallazgos H1–H52 verificados adversarialmente contra main 9befbe6). Si editas el plan base, re-valida que estos ajustes sigan vigentes.*
