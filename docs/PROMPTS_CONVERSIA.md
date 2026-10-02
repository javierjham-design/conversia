# Prompts de desarrollo — Conversia.cl (plataforma vertical llave en mano)

Plan de implementación segmentado en **etapas mergeables**, en orden de dependencia,
derivado de los análisis del 2026-09-30: `CONVERSIA_VERTICALES.md` (estrategia),
`CONVERSIA_MONTAJE.md` (arquitectura: un backend, dos frontends — opción 1 con
disciplina de opción 3), `CONVERSIA_MERCADO.md` (mercado y modelo dual) y
`CONVERSIA_COSTOS.md` (planes, cuotas y márgenes cerrados). Cada etapa es un prompt
autocontenido para una sesión de desarrollo en VS: se pega tal cual.

## Orden y dependencias

| Etapa | Qué | Depende de | Migración | Riesgo |
|---|---|---|---|---|
| **E1–E5** | Medidor y cobro de mensajes de servicio (**prompts incluidos abajo, en este mismo documento**) | nada | sí (E3) | **prerrequisito de todo — el cobro de Meta está vivo desde el 1-oct** |
| **F1** | Backend brand-aware (marca por organización) | nada | **sí (1: columna `brand`)** | bajo (defaults = TuBot; TuBot no nota nada) |
| **F2** | Motor de paquetes verticales | nada (paralelo a F1) | **sí (1: tabla de plantillas)** | bajo (aditivo) |
| **F3** | `apps/conversia-web` — MVP con design system propio | F1 mergeada (marca) · F2 para el registro por vertical | no | medio (app nueva, no toca las existentes) |
| **F4** | Agenda nativa completa (reagendar/cancelar/confirmar) | nada (paralelo) | no | medio (toca el motor de agenda compartido) |
| **F5** | Planes Conversia en BD + setup fee + sobres + pesos bolsa | E1–E3 mergeadas (débito de servicio) · F1 (marca) | no (seeds/config) | bajo |
| **F6** | Contenido verticales piloto + tenant comercial Conversia + montaje ampliado | F2 mergeada | no (datos) | bajo |
| **F7** | Soporte in-app con IA (widget + ticket + continuidad WhatsApp) | F1 y F3 mergeadas | **sí (1: enum canal WEBCHAT)** | medio |
| **F8** | Agenda administrable por el dueño vía bot (tools de horarios) | F4 mergeada | no | medio (tools de escritura con guardia de identidad) |
| **F9** | Módulo de recaudación y caja (flujos de dinero) | F3 mergeada (pantalla) · webhooks de cobro existentes | **sí (ledger + cierres)** | **alto — maneja dinero: prompt con reglas no negociables** |
| **F10** | Consola de operación Conversia (back-office del equipo: implementación, números, agentes, flujos por cliente + contexto total para soporte) | F2 mergeada · ideal F5/F7 | **sí (1: rol operador)** | medio — es el corazón operativo del modelo llave en mano |

F1, F2 y F4 pueden correr en paralelo. F3 es la etapa larga (diseño + pantallas).

**Etapa 0 (operativa, NO es prompt de VS — es contigo, Javier):**
- DNS de conversia.cl → Railway (y decidir subdominio del panel: `app.conversia.cl` recomendado, dejando conversia.cl para la landing).
- Brief de diseño del design system Conversia (estilo, paleta, tipografía, tono) — sesión aparte antes de F3.
- Confirmar los 2 verticales piloto (recomendados: dental + barbería/peluquería).
- Dominio de correo: agregar conversia.cl a Resend (no-reply@conversia.cl) antes de activar F1 en producción.
- Legales de Conversia (adaptar los de TuBot; anexo salud para dental).
- Cuenta/medio de cobro: los planes Conversia se cobran por Flow (CLP) y Lemon Squeezy (USD — estrenar; pendiente W-3 para sobres en USD).
- Crear la organización tenant "Conversia" (proveedora de montaje y ventas) cuando F6 lo pida.

**Regla transversal:** trabajar SIEMPRE en el clon `conversia-crm` con `main` al día.
Referencias `archivo:línea` al main del 2026-09-30 (último commit 7ddeeb7); si una
línea se movió, manda el símbolo/función. Todo texto de UI y docs en español de Chile;
código e identificadores en inglés. Cada etapa = un PR con CI verde
(`pnpm typecheck && pnpm test`).

---

## ETAPAS E1–E5 — Medidor y cobro de mensajes de servicio de WhatsApp (PRERREQUISITO)

> **Integrado a este plan el 2026-10-01** (antes en `PROMPTS_SERVICIO_OCT2026.md`, que queda como referencia histórica). **El cobro de Meta ya está VIVO desde hoy**: cada mensaje de servicio sobre los 1.000 gratis/mes por número cuesta ~USD 0,02 en Chile. Estas cinco etapas son lo PRIMERO a ejecutar — sin ellas, el costo principal de Conversia (y de TuBot) es invisible.

Plan de implementación segmentado en **5 etapas mergeables**, en orden de dependencia,
derivado de la auditoría del 2026-08-31 (artifact «TuBot Octubre 2026»). Cada etapa es
un prompt autocontenido para una sesión de desarrollo en VS: se pega tal cual, sin
depender del contexto de otra sesión.

### Orden y dependencias (E1–E5)

| Etapa | Qué | Depende de | Migración | Riesgo |
|---|---|---|---|---|
| **E1** | Tarifas efectivas por fecha (bloque 2) | nada | no | nulo (función pura + tests) |
| **E2** | Medición de servicio + W-2 (bloque 1) | E1 mergeada | no | bajo (solo registra, no frena) |
| **E3** | Migración + cupo de conversaciones (bloque 3) | E2 mergeada + **OK del dueño a la migración** | **sí (1)** | medio (frena; sale con enforcement APAGADO) |
| **E4** | Una respuesta por turno (bloque 4) | E2 mergeada | no | bajo |
| **E5** | Copy y avisos (bloque 5) | E1–E3 mergeadas (los textos citan el cupo) | no | nulo |

E4 puede correr en paralelo con E3. E5 va al final porque sus textos nombran el cupo.

**Etapa 0 (operativa, NO es prompt de VS — es contigo):** cifra del bloque 1 + lista
6.1 (consultas listas, faltaba OK de acceso a BD prod) · decisión A3 (tarjeta del
cliente vs OBO) · rate card definitivo de Meta del 1-sep (confirmar USD 0,0200 y la
etiqueta de categoría del webhook) · siembra de `platform_settings` (schedule + techos
svc) tras mergear E1/E3 · números de cupo por plan tras ver la cifra.

**Regla transversal:** trabajar SIEMPRE en el clon `conversia-crm` con `main` al día.
(El clon viejo `conversia` quedó en la rama `fix/precios-bot-enterprise` con commits
sin mergear — resolverla aparte, no mezclar.)

Las referencias `archivo:línea` son al main del 2026-08-31 (commit 49c9e6a): si una
línea se movió, la referencia por símbolo/función manda.

---

## PROMPT E1 — Tarifas de WhatsApp efectivas por fecha

```text
Contexto: el 1 de octubre de 2026 Meta empieza a cobrar los mensajes de SERVICIO de
WhatsApp (respuestas libres dentro de la ventana de 24 h), que hoy son gratis. En Chile
costarán USD 0,0200 por mensaje. Esta etapa construye SOLO el cimiento: que la función
de tarifas soporte precios con fecha de vigencia, sin tocar ningún flujo de envío ni
cobrar nada todavía. Es la etapa 1 de 5 del plan "servicio octubre 2026"
(docs/PROMPTS_SERVICIO_OCT2026.md).

Lee antes de escribir código: CLAUDE.md, docs/BILLING.md, docs/PLANS_AND_LIMITS.md.

REGLAS
· NO tocar apps/web/src/app/admin ni apps/api/src/platform. No hace falta:
  platform.controller.ts llama a computeWhatsappCostUsd con parámetros posicionales
  (líneas ~1289-1290) y el cambio de firma es retrocompatible (parámetro opcional).
  Verifica al final con typecheck que platform compila SIN cambios.
· NO sembrar nada en la base de datos ni en platform_settings: la siembra del
  calendario de tarifas en producción es un paso operativo aparte que hace el dueño.
· Todo texto/comentario en español de Chile. Un solo PR, CI verde
  (pnpm typecheck && pnpm test).

TAREA 1 — Extender computeWhatsappCostUsd (packages/agents/src/pricing.ts)
· Nuevo tipo exportado:
    export type WhatsappRateSchedule = Record<string, Partial<Record<
      "marketing" | "utility" | "authentication" | "service",
      { effectiveFrom: string; rateUsd: number }[]
    >>>;
  (clave externa = país ISO, igual que WHATSAPP_PRICING).
· Firma nueva, retrocompatible:
    computeWhatsappCostUsd(category, countryIso, overrides?, opts?: {
      at?: Date; schedule?: WhatsappRateSchedule })
· Precedencia, en este orden: (1) tramo del schedule del país cuyo effectiveFrom sea
  el MAYOR que cumpla effectiveFrom <= at (comparación en UTC, límite INCLUSIVE:
  a las 2026-10-01T00:00:00Z exactas ya rige el tramo); (2) override plano de
  `overrides` (comportamiento actual); (3) tabla base WHATSAPP_PRICING; país sin
  entrada → fila "default". Sin `at` o sin `schedule` → comportamiento idéntico al
  actual (los call sites existentes NO cambian: apps/worker/src/inbound.ts:193,
  apps/api/src/notifications/notifications.controller.ts:246, platform.controller).
· El case "service" YA existe en el switch (pricing.ts:151-152) — no lo dupliques.
  El helper clp() sigue fijando service: 0 en la tabla base (correcto: la tarifa de
  octubre entra por schedule/override, no hardcodeada).
· Actualiza el docblock de pricing.ts (líneas 52-63): ya no debe afirmar "los mensajes
  de SERVICIO son GRATIS" — debe decir "gratis hasta el 2026-09-30; desde el
  2026-10-01 se cobran (tramo por fecha vía schedule)".

TAREA 2 — Lector del calendario en el worker (apps/worker/src/cost-settings.ts)
· Nueva función getWhatsappRateSchedule(): lee platform_settings key
  "whatsappRateSchedule", cache 60 s, mismo patrón exacto de
  getWhatsappRatesOverride() (mismo archivo). JSON inválido o key ausente → {} (fail
  open a "sin schedule"). NO la conectes aún a ningún envío: eso es la etapa E2.
· Motivo de que sea una key SEPARADA de "whatsappRates": el zod del PATCH
  /platform/cost-settings hace strip de campos desconocidos y el merge de la
  calculadora del admin pisaría tramos metidos dentro de whatsappRates. NO los mezcles.

TAREA 3 — Tests (packages/agents/src/whatsapp-pricing.test.ts)
El test actual "servicio (dentro de la ventana de 24 h) es gratis" (línea 11-13)
cambia DELIBERADAMENTE. Debe quedar, como mínimo, con fecha inyectada (jamás el reloj
del sistema):
· servicio CL con at = 2026-09-30T23:59:59Z y schedule cargado → 0
· servicio CL con at = 2026-10-01T00:00:00Z (límite exacto) → 0.02
· servicio CL sin schedule (solo overrides planos con service: 0.02) → 0.02 desde ya
  (documenta: el override plano NO tiene fecha; por eso producción usará schedule)
· país sin entrada en el schedule → cae a override plano → tabla base
· schedule con dos tramos → gana el más reciente vigente
· categoría desconocida → 0 (comportamiento actual, no inventar costo)
· los 5 tests existentes siguen pasando sin tocar sus asserts salvo el de servicio

TAREA 4 — Documentación (docs/BILLING.md)
Sección nueva "Tarifa de mensajes de servicio (octubre 2026)": qué key es
(platform_settings.whatsappRateSchedule), formato JSON con el ejemplo de Chile
(USD 0,0200 desde 2026-10-01T00:00:00Z), cómo se cambia sin deploy (SQL o API), y el
checklist del 1 de septiembre cuando Meta publique el rate card definitivo: confirmar
el precio CL, confirmar con qué etiqueta llega la categoría en el webhook de status
(¿"service"? ¿"utility"?), verificar si aparecieron tramos de volumen para servicio, y
revisar usdToClp.

ENTREGA (en el mensaje final de la sesión)
· Archivos tocados y por qué. · Decisiones tomadas (precedencia, límite inclusive,
key separada). · Salida de pnpm typecheck y pnpm test en verde. · Confirmación
explícita de que apps/api/src/platform y apps/web/src/app/admin quedaron sin cambios.
```

---

## PROMPT E2 — Medición de mensajes de servicio + reembolso W-2

```text
Contexto: desde el 1 de octubre de 2026 Meta cobra los mensajes de servicio de
WhatsApp (hoy gratis). Esta etapa hace que cada mensaje de servicio saliente DEJE
RASTRO Y COSTO (medición en producción, costo 0 hasta octubre) y cierra el pendiente
W-2 (reembolso de bolsa al fallar un envío de plantilla). NO frena nada todavía: los
topes son la etapa E3. Es la etapa 2 de 5 (docs/PROMPTS_SERVICIO_OCT2026.md);
la E1 (tarifas por fecha) YA está mergeada — usa su API.

Lee antes: CLAUDE.md, docs/PREPAID_WALLET_DESIGN.md, docs/BILLING.md,
docs/WHATSAPP.md, docs/PENDIENTES.md (ítems W-2 y 0-bis), docs/MULTITENANCY.md.

DATO CLAVE QUE NO ES OBVIO (verificado en auditoría): el bot NO pasa por la cola
"outbound". apps/worker/src/agent-turn.ts persiste el message y llama a Graph API en
el MISMO proceso (send directo ~línea 561). La cola outbound solo lleva mensajes del
panel (humanos). Si instrumentas solo outbound.ts, dejas fuera el 100% del tráfico del
bot. Los CUATRO orígenes de mensaje de servicio por WhatsApp son:
  1. apps/worker/src/agent-turn.ts — respuesta del bot (send ~:561, éxito ~:574-585)
  2. apps/worker/src/outbound.ts — humano desde bandeja: rama texto (~:84) y rama
     adjunto IMAGE/DOCUMENT (~:73); ambas cuestan como servicio
  3. apps/worker/src/workflow-runtime.ts — nodo send_text (~:74-101)
  4. apps/worker/src/appointment-responses.ts — acuse de recordatorio (~:42-51)
Messenger/Instagram (apps/worker/src/messaging-send.ts) quedan FUERA: Meta no los
cobra con este rate card.

REGLAS
· NO tocar apps/web/src/app/admin ni apps/api/src/platform.
· NO frenar ni bloquear ningún envío de servicio en esta etapa (solo registrar).
· No romper: las 6 compuertas de plantillas, la bolsa prepagada, el fusible global,
  el aislamiento por organización (RLS/withTenant), el montaje asistido.
· Sin migraciones: todo cabe en el esquema actual (wallet_ledger.category es String
  nullable; usage_events.type es String libre).
· Español de Chile. Un PR (o dos si prefieres separar W-2), CI verde.

TAREA 1 — Categoría "service" en el modelo de costos (apps/worker/src/wallet.ts)
· WalletCategory pasa a "utility" | "marketing" | "authentication" | "service" (:26).
· normalizeCategory() (:55-60) se vuelve EXPLÍCITA. Contrato nuevo:
    normalizeCategory(category): WalletCategory | { unknown: string }
  Mapea (case-insensitive): UTILITY→utility, MARKETING* → marketing, AUTH* →
  authentication, SERVICE→service. CUALQUIER otro valor devuelve { unknown: raw }.
  PROHIBIDO el default a utility: hoy "service" se disfrazaría de utility en silencio
  y eso es exactamente el bug que estamos matando.
· En debitForMessage (plantillas): si la categoría es unknown, cobra peso 1, escribe
  en el ledger la categoría CRUDA (columna category, String) y deja un console.warn
  visible con organizationId y el valor recibido. Registrada tal cual, nunca
  disfrazada.
· readWeights()/walletWeights (:32-48): incorpora service (default 1) al tipo Weights
  y al parse. No afecta la bolsa (el servicio no la toca) — es consistencia del tipo
  y deja el peso listo.

TAREA 2 — Registro por mensaje de servicio saliente (módulo nuevo
apps/worker/src/service-metering.ts)
· export async function recordServiceSend(organizationId, messageId, conversationId,
  toPhone): Promise<void>
· Qué hace: escribe UN asiento WalletLedger con reason "service_send", delta 0 (la
  bolsa es SOLO de plantillas — no altera balance ni balanceAfter), category
  "service", costUsd = computeWhatsappCostUsd("service",
  geoFromPhone(toPhone).country, await getWhatsappRatesOverride(),
  { at: new Date(), schedule: await getWhatsappRateSchedule() }),
  refType "message", refId = messageId.
· IDEMPOTENTE por messageId: mismo patrón de debitForMessage (findFirst previo por
  reason+refType+refId; el índice [organizationId, refType, refId] de wallet_ledger
  ya existe). Un reintento del mismo mensaje NO escribe dos veces.
· balanceAfter: usa el balance actual de la bolsa sin modificarlo (léelo; si no hay
  bolsa, 0). Best-effort: un fallo de registro NO puede tumbar el envío (try/catch
  con console.error, como notifyWalletThresholds).
· Llamada POST-ÉXITO del envío en los 4 orígenes de arriba (cuando el send a Graph
  API devolvió OK y el message quedó SENT). No pre-envío: medir no debe poder frenar.
  En outbound.ts cuidado: solo mensajes PUBLIC dirigidos a WhatsApp (la rama sin
  teléfono va a Messenger/IG y NO se registra).
· El UsageEvent por conversación (type "conversation") NO va en esta etapa: depende
  del contador de la migración de E3. Déjalo anotado en el módulo como TODO E3.

TAREA 3 — Destrabar el registro post-facto del webhook (apps/worker/src/inbound.ts)
· Hoy (:184) el usage_event whatsapp_message solo se escribe si
  status.pricing?.billable && status.pricing.category. Cambia la condición: se
  registra SIEMPRE que venga status.pricing?.category (aunque billable sea false),
  guardando además meta.billable (boolean) tal como llegó.
· El costUsd sale de computeWhatsappCostUsd(category, country, overrides,
  { at: new Date(), schedule }) — para servicio hoy da 0 y desde el 1-oct dará
  0,0200 solo. La categoría se pasa CRUDA a computeWhatsappCostUsd (esa función ya
  maneja desconocidas devolviendo 0) y se guarda cruda en meta.category.
· Mantén el dedupe por externalId EXACTAMENTE como está (findFirst por
  meta.externalId). Nota en comentario: este dedupe gana un índice en la migración
  de E3; no lo "optimices" aquí.
· Resultado: desde este deploy medimos el volumen real de servicio en usage_events
  (costo 0) — dos semanas de datos antes del cobro. El asiento del ledger (tarea 2)
  es la ESTIMACIÓN al enviar; el usage_event del webhook es la VERDAD de Meta. Nunca
  se suman: se concilian por externalId (messages.external_id → wallet_ledger.refId
  vía message.id). Deja esto explicado en un comentario en service-metering.ts.

TAREA 4 — W-2: reembolso de bolsa al fallar un envío de PLANTILLA
refundForMessage (apps/worker/src/wallet.ts:183-201) ya existe y ya es idempotente
(anti-doble-refund incluido). Hoy solo lo llama el corte del fusible
(messaging-guard.ts:176). Agrega el refund en los TRES fallos terminales:
· outbound.ts (~:133-173): cuando el send de una PLANTILLA lanza y el mensaje queda
  FAILED — incluye ChannelAuthError y ChannelConfigError (no se reintentan). Refund
  ANTES del return/throw. En el throw final (reintento BullMQ) NO refundees: el
  débito es idempotente y el reintento puede triunfar.
· workflow-runtime.ts (~:452-466): fallo del envío del nodo sendTemplate → refund.
· inbound.ts (~:149-178): cuando el webhook de statuses reporta "failed" para un
  mensaje que ERA plantilla: resuelve message por externalId dentro del tenant, y si
  message.type === "TEMPLATE", refundForMessage(organizationId, message.id). Es el
  caso asincrónico que hoy se escapa siempre. Un segundo webhook failed del mismo
  mensaje no devuelve dos veces (ya lo garantiza refundForMessage).
· De servicio no hay refund (delta 0, nada que devolver).

TAREA 5 — Dos corrección de paso (auditoría N2 y N3)
· N3: apps/worker/src/notifications/whatsapp-escalation.ts (~:92) envía una plantilla
  HSM sin pasar por chargeTemplateSend → fuga de bolsa/fusible. Hazla pasar por
  chargeTemplateSend (categoría de la plantilla; usa el id del message que ya crea, y
  si no crea ninguno, créalo antes para tener messageId estable). Si el gate bloquea:
  no enviar, integrationEvent tipo "template.blocked" (patrón outbound.ts:108-117).
· N2: la cola "outbound" no tiene reintentos (nadie define attempts; BullMQ usa 1) y
  el comentario de outbound.ts:173 ("BullMQ reintenta según la política del worker")
  es FALSO hoy. Define en las 3 llamadas .add() de
  apps/api/src/conversations/conversations.controller.ts (~:816, ~:897, ~:1036)
  { attempts: 3, backoff: { type: "exponential", delay: 3000 } } — es seguro: el
  débito de bolsa es idempotente por messageId y el gate corta con return (sin
  throw). Verifica que processOutbound siga siendo re-entrante (message.status
  PENDING check de la línea 14 hace que un reintento tras éxito sea no-op).

TAREA 6 — Tests + matriz
· Tests del worker (vitest, patrón billing-dunning.test.ts / contact-capture.test.ts
  con mocks de prisma):
  - normalizeCategory: 4 conocidas + desconocida NO disfrazada (contrato nuevo).
  - recordServiceSend: escribe una vez; segundo llamado con mismo messageId = no-op;
    costo 0 con fecha de hoy y 0,02 con at posterior al 1-oct (schedule inyectado).
  - refund: fallo terminal → devuelve; doble fallo → devuelve UNA vez; fallo con
    reintento exitoso posterior → sin refund neto incorrecto.
· Crea docs/SERVICE_MESSAGES_TEST_MATRIX.md con la tabla de casos de esta etapa
  (mensaje antes/después del 1-oct, reintento, fallo terminal, categoría
  desconocida) y columna de estado. Las etapas E3-E5 le agregan sus filas.
· Prueba de humo local con el simulador: node scripts/simulate-inbound.mjs --phone
  569XXXXXXXX --text "hola" --org digital-dent y verifica el asiento service_send en
  wallet_ledger y el usage_event al simular el status.

ENTREGA
· Archivos tocados agrupados por tarea, decisiones (por qué delta 0, por qué
  post-éxito, por qué la condición del webhook quedó así), matriz con resultados,
  typecheck + suite en verde, y confirmación de que NO se bloqueó ningún envío de
  servicio en ningún camino.
```

---

## PROMPT E3 — Migración + cupo de conversaciones por período

```text
Contexto: desde el 1 de octubre de 2026 Meta cobra los mensajes de servicio. La
medición ya está desplegada (etapa E2: ledger service_send + usage_events). Esta
etapa agrega el FRENO: cupo de conversaciones por período en el plan, contador
atómico, avisos 80/100%, tope blando por defecto / duro para demo, y fusible global +
tope diario para servicio. Decisión de producto YA TOMADA por el dueño: la bolsa
prepagada sigue siendo SOLO de plantillas; el servicio se controla por conversaciones
(la unidad que el cliente entiende); el costo por mensaje se sigue registrando aparte
(E2). Es la etapa 3 de 5 (docs/PROMPTS_SERVICIO_OCT2026.md).

Lee antes: CLAUDE.md, docs/PREPAID_WALLET_DESIGN.md, docs/PLANS_AND_LIMITS.md,
docs/MULTITENANCY.md, docs/DEPLOYMENT.md (runbook de migración, líneas 28-55),
docs/BILLING.md.

REGLAS
· MIGRACIÓN: proponla, muéstrala completa con su plan de reversa y ESPERA EL OK
  EXPLÍCITO del dueño en esta conversación antes de aplicarla en cualquier base que
  no sea tu entorno local. Para producción rige el runbook de DEPLOYMENT.md (doble
  backup + prisma migrate deploy + REEJECUTAR sql/setup.sql porque hay tablas nuevas
  + smoke test). No la apliques sola.
· NO tocar apps/web/src/app/admin. En apps/api/src/platform hay UN cambio opcional
  (interruptor de tope duro por tenant, tarea 5): PÁRATE Y PIDE OK antes de tocarlo;
  si el dueño no lo da, deja el interruptor operable solo por SQL y documéntalo.
· El deploy de esta etapa sale con el enforcement APAGADO por defecto (cupo 0 = solo
  medición). Encenderlo = sembrar features en los planes, paso operativo del dueño
  con los números que salgan de la cifra del bloque 1. Nada se rompe si nadie siembra.
· No romper: 6 compuertas de plantillas, bolsa, fusible de plantillas, RLS,
  montaje asistido. Español de Chile. CI verde + pnpm --filter @conversia/database
  verify:isolation en verde tras la migración local.

TAREA 1 — Migración (packages/database): 2 tablas + 1 índice, ADITIVA
· Modelos Prisma (snake_case vía @@map, como todo el schema):
    model ConversationQuotaMark {
      id             String   @id @default(cuid())
      organizationId String   @map("organization_id")
      conversationId String   @map("conversation_id")
      periodStart    DateTime @map("period_start") @db.Date
      createdAt      DateTime @default(now()) @map("created_at")
      @@unique([organizationId, conversationId, periodStart])
      @@index([organizationId, periodStart])
      @@map("conversation_quota_marks")
    }
    model ConversationQuotaCounter {
      organizationId String   @map("organization_id")
      periodStart    DateTime @map("period_start") @db.Date
      used           Int      @default(0)
      overage        Int      @default(0)
      included       Int      @default(0)   // snapshot del plan al abrir el período
      updatedAt      DateTime @updatedAt @map("updated_at")
      @@id([organizationId, periodStart])
      @@map("conversation_quota_counters")
    }
· En el SQL de la migración agrega A MANO (Prisma no modela índices de expresión):
    CREATE INDEX usage_events_ext_idx
      ON usage_events (organization_id, type, (meta->>'externalId'));
  Es el dedupe del webhook de statuses (hoy escanea). Si la tabla ya es grande en
  prod, el runbook lo aplica con CREATE INDEX CONCURRENTLY fuera de la transacción.
· Plan de reversa (déjalo escrito en la migración como comentario y en la entrega):
  DROP TABLE conversation_quota_marks, conversation_quota_counters;
  DROP INDEX usage_events_ext_idx; + redeploy del código anterior. Aditiva: ningún
  código previo lee estas tablas; los asientos service_send y usage_events quedan
  inertes.
· Tras migrar local: pnpm db:setup (las tablas llevan organization_id → heredan RLS
  y FK dinámica) y verify:isolation en verde.

TAREA 2 — Features del plan (sin DDL: son JSON)
· Convención OBLIGATORIA (es la del vecino features.templateMessages, no la de
  limits): 0 = sin cupo definido → SOLO medición, sin avisos ni topes; -1 =
  ilimitado (mide y avisa nunca); N>0 = cupo mensual.
· features nuevos: conversationsPerPeriod (número), conversationOverageClp (número,
  CLP por conversación extra; 0 = no facturar overage), conversationHardCap
  (boolean, default false = tope blando).
· Seed (packages/database/src/seed.ts, bloque PLANS ~:307-349): agrega los tres
  features a los 4 planes con conversationsPerPeriod: 0 en TODOS (apagado) y
  conversationHardCap: true SOLO en free. Comentario: "números reales los siembra el
  dueño con la cifra del bloque 1". El upsert del seed ya actualiza features.
· FUENTE DEL PLAN: usa la suscripción ACTIVE/TRIALING más reciente (patrón de
  apps/api/src/common/plan-limits.ts getEntitlements), NO organization.planId.
  (Auditoría N4: hoy wallet.ts usa organization.planId y plan-limits usa la
  suscripción; para el cupo se usa la suscripción, y deja un TODO visible en
  wallet.ts anotando la divergencia — NO la arregles en esta etapa.)

TAREA 3 — Contador atómico e idempotente (apps/worker/src/conversation-quota.ts)
· Período: periodStart = date_trunc a día, en UTC, del inicio del período de
  facturación: subscription.periodStart::date de la suscripción activa si existe;
  si no, el día 1 del mes calendario UTC. Función pura resolvePeriodStart(sub, now)
  con tests.
· export async function countConversationOnce(organizationId, conversationId, now):
  (1) resuelve periodStart; (2) INSERT de la marca con ON CONFLICT DO NOTHING
  ($executeRaw o create con catch de unique violation): si NO insertó → la
  conversación ya contó este período → return { counted: false, ...estado }; (3) si
  insertó: upsert de la fila del counter (si se crea, included = snapshot de
  features.conversationsPerPeriod del plan vigente) y UPDATE atómico
  used = used + 1 (y overage = overage + 1 cuando used ya superó included con cupo
  N>0) en UNA sentencia SQL; (4) escribe UsageEvent type "conversation", quantity 1,
  meta { conversationId, periodStart, overage: boolean } — este es el UsageEvent por
  conversación que pedía el bloque 1.2, vive aquí porque depende del contador; (5)
  devuelve { counted, used, included, overagePct } para los avisos.
· Idempotencia total por (org, conversación, período) vía el UNIQUE de la marca. Dos
  tenants o dos workers en paralelo jamás se pisan (el UNIQUE + UPDATE atómico
  deciden). Nada de leer-luego-escribir sin candado.

TAREA 4 — Compuerta de servicio (apps/worker/src/messaging-guard.ts, función NUEVA)
· export async function chargeServiceSend(organizationId, conversationId):
  Promise<SendGate> — SEPARADA de chargeTemplateSend (que no se toca). Orden:
  (1) countConversationOnce + evaluación de cupo; (2) tope diario svc por tenant;
  (3) fusible global svc. Fail ABIERTO ante errores de infraestructura (Redis/BD
  caída no puede callar el bot), pero el corte por tope duro SÍ cierra.
· Cupo (con conversationsPerPeriod N>0):
  - al cruzar 80%: enqueueNotification eventKey "conversations.low" (una vez por
    período: SETNX patrón wallet.ts firstTime()).
  - al llegar/superar 100% con tope BLANDO (default): NO bloquea; el excedente ya
    quedó contado como overage (tarea 3); notificación "conversations.limit" una vez
    por período.
  - al 100% con tope DURO (features.conversationHardCap === true, o override por
    tenant settings.messaging.conversationHardCap === true, o org.status TRIAL, o
    suscripción PAST_DUE/SUSPENDED): bloquea SOLO si la conversación NO alcanzó a
    contar (marca nueva rechazada por cupo lleno: en tope duro el paso (2) de la
    tarea 3 se hace condicional — usa una variante checkAndCount que no inserta la
    marca si used >= included). Mensaje de usuario del gate:
    "⚠ Envío no realizado: tu cuenta alcanzó el cupo de conversaciones del período.
    El bot pausó las respuestas automáticas. Para reanudarlas hoy mismo: sube de
    plan o escríbenos por Soporte. Las conversaciones ya abiertas no se pierden."
· Contadores Redis PARALELOS a los de plantillas — claves msgcap:svc:t:{org}:{día} y
  msgcap:svc:g:{día}, techos en platform_settings keys "messagingCapSvcPerTenantDay"
  y "messagingCapSvcGlobalDay" (patrón readGlobalCaps con cache 60 s; defaults env
  nuevos MSG_CAP_SVC_PER_TENANT_DAY=3000, MSG_CAP_SVC_GLOBAL_DAY=20000 en
  @conversia/config + .env.example). PROHIBIDO compartir el contador con plantillas:
  el volumen de servicio es 10-100x y dispararía el fusible de plantillas.
· El fusible svc al cortar: alerta OPS una vez al día (patrón tripFuse, summary
  "TuBot: fusible de mensajes de servicio cortado") y expone su estado junto a
  /health/fuse (agrega el dato al payload existente sin romper el contrato actual).
· Al bloquear por tope duro: mensaje SYSTEM en la bandeja (patrón outbound.ts:95-106)
  + integrationEvent "service.blocked" + audit_log (queda en auditoría, requisito
  3.5). El texto del mensaje al cliente final NO existe (al cliente final no se le
  escribe nada: simplemente el bot no responde y el tenant ve el motivo en su
  bandeja).
· CALL SITES: chargeServiceSend va ANTES del envío en los mismos 4 orígenes que
  recordServiceSend (E2): agent-turn.ts, outbound.ts (texto/adjunto WhatsApp),
  workflow-runtime.ts send_text, appointment-responses.ts. Si el gate bloquea:
  message → FAILED con gate.userMessage, no se llama a Graph, no se registra
  service_send.
· Eventos nuevos del catálogo (packages/notifications/src/catalog.ts):
  "conversations.low" ("Tu cupo de conversaciones va en {pct}% ({used} de
  {included}). Al llegar al 100% el excedente se cobra como sobreconsumo.") y
  "conversations.limit" ("Alcanzaste el 100% de tu cupo de conversaciones
  ({included}). Sigues atendiendo sin cortes: el excedente se suma a tu factura como
  sobreconsumo." — variante si hard cap: "...el bot pausó las respuestas
  automáticas; sube de plan para reanudarlas."). Audiencia owner+tenant_admins,
  urgency critical, canales in_app/web_push/email, defaults in_app/email, link
  "/billing". Solo la entrada del catálogo + enqueueNotification: el despachador no
  cambia.

TAREA 5 — Interruptor por tenant para endurecer el tope (Super Admin)
· El dato: settings.messaging.conversationHardCap (boolean) en organizations.settings.
· El endpoint natural es extender PATCH /platform/organizations/:id/messaging-cap
  (platform.controller.ts:1005-1017) para aceptar también conversationHardCap
  opcional — ESO TOCA apps/api/src/platform: MUESTRA el diff propuesto (son ~5
  líneas del zod + merge de settings) y PIDE OK AL DUEÑO antes de aplicarlo. Sin OK:
  no lo toques; documenta en docs/BILLING.md el UPDATE SQL equivalente para
  encenderlo a mano y sigue.

TAREA 6 — Tests + matriz (agrega filas a docs/SERVICE_MESSAGES_TEST_MATRIX.md)
· resolvePeriodStart (con y sin suscripción, cambio de mes, anclas).
· countConversationOnce: cuenta 1 sola vez por período; período nuevo re-cuenta;
  concurrencia (dos llamadas simultáneas → used sube exactamente 1).
· Aislamiento: dos organizaciones en paralelo no se tocan (y verify:isolation).
· Gate: 80% avisa una vez y deja pasar; 100% blando pasa y acumula overage; 100%
  duro corta con mensaje y auditoría; cupo 0 = todo pasa sin avisos (enforcement
  apagado); -1 = ilimitado; fusible svc activo → ningún servicio sale y las
  PLANTILLAS siguen saliendo (contadores separados, pruébalo explícito); Redis caído
  → fail open.
· agent-turn con gate bloqueado: el message queda FAILED, no hay llamada al provider
  (mock), queda el SYSTEM message + integrationEvent + audit_log.

ENTREGA
· La migración completa con reversa y el estado del OK del dueño (dado/pendiente).
· Archivos por tarea, decisiones (período anclado a suscripción, enforcement apagado
  por defecto, contadores Redis separados, variante checkAndCount del tope duro).
· Matriz actualizada con resultados. Typecheck + suite + verify:isolation en verde.
· Qué queda para el dueño: sembrar features con los números de la cifra, sembrar los
  techos svc, y el OK de la tarea 5 si no lo dio.
```

---

## PROMPT E4 — Una sola respuesta por turno

```text
Contexto: desde el 1 de octubre de 2026 cada mensaje de servicio de WhatsApp cuesta
(~$19 CLP en Chile). Un bot que responde en 4 burbujas gasta 4x. VERIFICADO en
auditoría: el orquestador YA emite un solo mensaje por turno
(packages/agents/src/orchestrator.ts devuelve UN string; agent-turn.ts crea UN
message; la auto-continuación por max_tokens concatena; el debounce de entrada ya
fusiona ráfagas del cliente). Esta etapa CONSOLIDA ese invariante para que ningún
cambio futuro lo rompa, y limpia las instrucciones que lo contradicen. Es la etapa 4
de 5 (docs/PROMPTS_SERVICIO_OCT2026.md); E2 ya está mergeada.

Lee antes: CLAUDE.md, docs/AGENTS.md, docs/TUBOT_TENANT.md (§2 y §3),
packages/agents/src/core-guardrails.ts, apps/worker/src/agent-turn.ts.

REGLAS
· NO tocar apps/web/src/app/admin ni apps/api/src/platform.
· El prompt del bot comercial de TuBot se edita en docs/TUBOT_TENANT.md (fuente de
  verdad) y se REGENERA el SQL — jamás editar seed-tubot-agents.sql a mano (lo pisa
  la próxima regeneración). APLICARLO a producción cambia el bot comercial vivo:
  deja el SQL regenerado listo y PIDE OK al dueño para aplicarlo (OK-7).
· No romper la transferencia entre agentes (recursión depth<1 en agent-turn.ts:607 —
  hasta 2 mensajes por turno, DELIBERADA: presenta al agente receptor) ni los
  workflows (varios send_text en un run son pasos intencionales del tenant).
· Español de Chile. CI verde.

TAREA 1 — Regla en el prompt base común (packages/agents/src/core-guardrails.ts)
· CORE_SCOPE_PREAMBLE (:12-21) se antepone SIEMPRE a todos los agentes de todos los
  tenants y no es desactivable. Agrega la regla 6 (mismo tono de las 5 existentes):
  "6. UNA SOLA RESPUESTA POR TURNO. Responde todo lo del turno en un único mensaje,
  completo y en tono de WhatsApp (frases cortas está bien — pero un solo envío).
  Nunca dividas la respuesta en varios mensajes seguidos para simular que escribes
  como humano."
· Verifica los consumidores de assembleSystemPrompt (agent-turn.ts:397,
  workflow-live-sim.ts:219, reliability-monitor.ts:71, agents.controller.ts:373,415)
  — no deben requerir cambios (typecheck lo confirma).

TAREA 2 — Guarda de salida en el runtime (apps/worker/src/agent-turn.ts)
· Tope configurable de envíos por turno: lee platform_settings key
  "maxAgentMessagesPerTurn" (default 1, cache 60 s — patrón readGlobalCaps de
  messaging-guard.ts). El turno raíz y su transferencia (depth 1) son turnos
  distintos: el tope aplica POR invocación de runAgentTurn, así la transferencia
  sigue funcionando (2 mensajes máx por mensaje del cliente, como hoy).
· Implementación: contador local en runAgentTurn; hoy solo hay un punto de creación
  del message del agente (:510-524) — la guarda es el cinturón para cambios futuros
  (p. ej. si alguien agrega streaming por párrafos): si el contador ya llegó al
  tope, los textos EXTRA se FUSIONAN al body del message existente (separados por
  salto de línea) en vez de crear messages nuevos. Excepción explícita: mensajes con
  adjunto (IMAGE/DOCUMENT) o TEMPLATE no se fusionan (requisito del dueño).
· Deja un test que rompa si alguien crea un segundo message TEXT del agente en el
  mismo turno sin pasar por la fusión.

TAREA 3 — Instrucciones de los agentes de TuBot (docs/TUBOT_TENANT.md → regenerar)
· §2 "Reglas de humanidad" (~línea 125): reemplaza "- Puede dividir en dos mensajes
  cortos cuando es natural, como una persona." por "- Escribe UNA sola respuesta por
  turno. Puede tener dos líneas cortas, pero es un solo mensaje."
· §3 prompt del comercial (~líneas 157-158): reemplaza "Puedes mandar dos mensajes
  cortos cuando es natural." por "Tu respuesta es UN solo mensaje por turno (dos
  líneas cortas está bien)." — conserva el resto de la frase sobre variar aperturas.
· Regenera: node packages/database/scripts/gen-tubot-agents-sql.mjs → verifica el
  diff de seed-tubot-agents.sql (SOLO deben cambiar esas frases). NO lo apliques a
  ninguna BD: deja el comando exacto listo y pide el OK del dueño en la entrega.
· Plantillas genéricas (apps/web/src/lib/agent-templates.ts:19 BASE_STYLE): agrega
  "en un solo mensaje" → "…breve (2-3 frases, una pregunta a la vez, en un solo
  mensaje)." Revisa que las 6 plantillas y los rubros (industry-templates.ts) no
  tengan otra instrucción multi-mensaje (la auditoría no encontró más).

TAREA 4 — Métrica antes/después (bloque 4.4)
· Documenta en docs/SERVICE_MESSAGES_TEST_MATRIX.md (sección "Métrica bloque 4") la
  consulta de mensajes salientes del bot por conversación (30 días):
    SELECT ROUND(AVG(n),2) FROM (SELECT COUNT(*) n FROM messages
      WHERE direction='OUTBOUND' AND author_type='AGENT'
        AND type NOT IN ('TEMPLATE','SYSTEM','NOTE') AND visibility='PUBLIC'
        AND created_at >= now() - interval '30 days'
      GROUP BY conversation_id) x;
  y registra el valor ANTES (pídeselo al dueño si no tienes acceso a prod; la
  consulta completa por tenant ya existe en el scratchpad de la auditoría). El
  DESPUÉS se mide a los 7 días del deploy con la misma consulta.

TAREA 5 — Tests
· Unit orquestador: sigue devolviendo un único reply (streaming/continuación
  concatenan) — asegura el invariante con un test si no existe.
· Integración agent-turn: turno normal → 1 message; turno con transferencia → 2
  messages (uno por agente); tope respetado con textos extra fusionados; adjunto o
  plantilla exentos de fusión.
· Matriz: fila "Agente que produce cuatro mensajes en un turno → sale uno solo".

ENTREGA
· Archivos tocados, diff del seed regenerado (sin aplicar) + comando de aplicación
  para el OK del dueño, valor de la métrica "antes" (o su estado), typecheck + suite
  en verde.
```

---

## PROMPT E5 — Copy veraz + avisos a clientes

```text
Contexto: desde el 1 de octubre de 2026 Meta cobra las respuestas dentro de la
ventana de 24 h de WhatsApp. El producto ya mide (E2) y topea por conversaciones
(E3). Esta etapa corrige TODO texto visible que promete que responder es gratis, y
deja PREPARADOS (no enviados) los avisos a clientes. El inventario exhaustivo ya
está hecho por auditoría — no re-descubras: ejecuta sobre esta lista. Es la etapa 5
de 5 (docs/PROMPTS_SERVICIO_OCT2026.md).

Lee antes: CLAUDE.md, docs/COPY_PENDIENTE_OCT2026.md (inventario previo, quedará
reescrito), docs/BILLING.md, packages/notifications/src/catalog.ts.

REGLAS
· NO tocar apps/web/src/app/admin (los 4 textos de esa zona quedan listados como
  pendientes de OK del dueño, no los cambies).
· NADA se envía a clientes: los avisos quedan como borradores + mecanismo listo.
· El prompt del bot comercial (TUBOT_TENANT.md) puede haber quedado ya tocado por la
  etapa E4 (frase multi-mensaje) — esta etapa cambia OTRA frase del mismo archivo
  (la de gratuidad). Mismo flujo: editar el .md, regenerar el SQL, NO aplicar sin OK.
· Español de Chile, fechas explícitas, nada de letra chica. CI verde.

TAREA 1 — Reemplazos de copy (textos EXACTOS, ya revisados con el dueño)
1. packages/notifications/src/catalog.ts:190 (evento wallet.empty — sale in-app y
   POR CORREO):
   «Tu bolsa de mensajes de plantilla llegó a 0. Compra un paquete o sube de plan
   para reanudar los envíos. Hasta el 30 de septiembre puedes seguir respondiendo
   dentro de las 24 h sin costo; desde el 1 de octubre cada respuesta descuenta de
   tu cupo mensual de conversaciones.»
   Deja un TODO fechado: el 1-oct se simplifica a «…Las respuestas dentro de las
   24 h no usan esta bolsa: descuentan de tu cupo mensual de conversaciones.»
2. apps/web/src/app/(app)/billing/wallet-card.tsx:52:
   «Los mensajes de plantilla (recordatorios, confirmaciones, campañas) descuentan
   de tu bolsa. Desde el 1 de octubre de 2026, WhatsApp también cobra las respuestas
   dentro de las 24 h: van contra tu cupo mensual de conversaciones, no contra esta
   bolsa.»
3. apps/worker/src/messaging-guard.ts:77 — reemplaza el cierre «Puedes seguir
   respondiendo dentro de las 24 h sin costo.» por «Puedes seguir respondiendo
   dentro de las 24 h con tu cupo de conversaciones.»
4. apps/worker/src/messaging-guard.ts:169 — ídem (mismo cierre nuevo).
5. apps/worker/src/messaging-guard.ts:90 (demo): «…Puedes seguir probando agentes,
   flujos y responder dentro de las 24 h (con el cupo de conversaciones del modo
   demo).»
6. apps/web/src/app/(app)/workflows/[id]/runs/page.tsx:326: agrega al final
   « Las respuestas dentro de 24 h usan tu cupo de conversaciones.»
7. docs/TUBOT_TENANT.md:241-242 (prompt del bot comercial; regenerar SQL, no
   aplicar): reemplaza «Responder dentro de 24 h es GRATIS. Explícalo simple si
   preguntan.» por «Las respuestas dentro de las 24 h descuentan del cupo de
   conversaciones del plan (hasta el 30 de septiembre de 2026 son gratis). Si
   preguntan por precios exactos, deriva al detalle del plan — no inventes cifras.»
8. Comentarios/docblocks que afirman gratuidad y quedaron desactualizados tras
   E1-E3 (verifica si E1/E2 ya los tocaron; corrige los que sigan): wallet.ts:23,
   messaging-guard.ts:9-10, pricing.ts si quedara algo. En docs internas
   (PREPAID_WALLET_DESIGN.md:8-11, WHATSAPP.md:21, SECURITY_AUDIT donde aplique)
   agrega la nota «[Vigente hasta 2026-09-30: desde el 1-oct el servicio se cobra —
   ver BILLING.md]» sin reescribir su historia.

TAREA 2 — Aviso a clientes actuales (PREPARAR, NO ENVIAR)
· Crea docs/AVISO_CLIENTES_OCT2026.md con los DOS borradores aprobados en auditoría:
  el correo (asunto «Cambio de WhatsApp desde el 1 de octubre: qué significa para tu
  cuenta», cuerpo con las 3 secciones: qué cambia / qué hicimos en TuBot: cupo de
  conversaciones, avisos 80-100%, sin cortes por defecto / qué tienes que hacer tú —
  ESTE PÁRRAFO TIENE DOS VARIANTES según la decisión A3 del dueño: (a) WABA propia
  del cliente → registrar medio de pago en Meta antes del 30-09 con mini-guía, (b)
  OBO/TuBot → «nada: nosotros administramos el pago a Meta») y el in-app
  («WhatsApp cobra las respuestas dentro de 24 h desde el 1 de octubre. Tu plan ya
  incluye un cupo mensual de conversaciones y avisos al 80 %. Revisa los detalles en
  Plan y facturación.»). Marca claramente cuál variante queda pendiente de A3.
· Mecanismo de disparo (sin disparar): evento nuevo del catálogo
  "announcement.oct2026" con hidden: true (no aparece en la matriz de preferencias),
  audiencia owner+tenant_admins, canales in_app+email, y un script
  scripts/send-oct2026-notice.mjs que recorre las organizaciones ACTIVE y encola la
  notificación UNA vez por org (idempotente con SETNX por org, patrón wallet.ts).
  El script exige el flag --confirm "SI-ENVIAR" para correr; sin el flag, imprime
  el listado de a quién le llegaría (dry-run). NO lo ejecutes ni siquiera en dry-run
  contra producción sin que el dueño lo pida.

TAREA 3 — Auditoría del cambio (docs/COPY_PENDIENTE_OCT2026.md)
· Reescribe el documento con el inventario COMPLETO de la auditoría y su estado:
  los 7 cambios de la tarea 1 (ruta, texto viejo → nuevo, fecha del cambio), los 4
  textos de apps/web/src/app/admin que quedaron PENDIENTES DE OK (calculator ×2:
  «servicio dentro de 24 h = gratis»; messaging-limits: «las respuestas dentro de
  24 h nunca se tocan»; messaging-cap-card: «solo plantillas (las que cuestan)») +
  la brecha funcional de la calculadora (no expone ni suma "service" — auditoría
  N7), y los textos verificados como NO afectados (landing, legales, semáforo de
  ventana de la bandeja) para que nadie los "corrija" de más.
· Verificación final: corre el barrido Grep («sin costo», «no cuesta», «no
  cuestan», «no cuentan», «gratis», «24 h» case-insensitive) sobre apps/ y
  packages/ y confirma en la entrega que no queda NINGUNA afirmación de gratuidad
  de las 24 h fuera de la lista de pendientes-OK del admin.

TAREA 4 — Matriz y cierre
· docs/SERVICE_MESSAGES_TEST_MATRIX.md: completa las filas restantes (copy: el
  correo de wallet.empty renderiza el texto nuevo — hay test del catálogo/render;
  el dry-run del script lista sin enviar) y deja la matriz completa con TODOS los
  casos de las 5 etapas y su estado final.
· Los tests de snapshot/render que existan sobre catalog.ts se actualizan con el
  texto nuevo (cambio deliberado, dilo en la entrega).

ENTREGA
· Tabla de textos cambiados (ruta, antes → después). · Lo pendiente de OK (admin +
  aplicación del seed del bot). · Confirmación del barrido final limpio. · Estado
  del mecanismo de aviso (borradores + script en dry-run, NADA enviado). ·
  Typecheck + suite en verde.
```

---

### Checklist operativo del dueño para E1–E5 (no es prompt — va en paralelo)

- [ ] **OK-1**: correr las consultas de solo lectura en prod → cifra bloque 1 + lista 6.1 + línea base 4.4.
- [ ] **OK-8 / A3**: decidir tarjeta-del-cliente vs OBO (define la variante del correo de E5 y el riesgo del 30-09).
- [ ] **1-sep**: rate card definitivo de Meta → confirmar USD 0,0200 CL y la etiqueta de categoría del webhook (checklist en BILLING.md tras E1).
- [ ] **OK migración E3** + aplicar por runbook (backup doble + migrate deploy + setup.sql + smoke).
- [ ] **Sembrar** `whatsappRateSchedule` (CL service 0,02 @ 2026-10-01T00:00:00Z), techos svc del fusible, y features de cupo por plan (con la cifra).
- [ ] **OK-7**: aplicar el seed regenerado de agentes TuBot a prod (E4 y E5 lo dejan listo).
- [ ] **OK-4/OK-5** (opcionales): endpoint hard-cap por tenant en platform + service en la calculadora del admin.
- [ ] **22-30 sep**: disparar el aviso a clientes (script de E5) + verificación final de medios de pago por WABA (6.1/6.2).

---

## PROMPT F1 — Backend brand-aware (marca por organización)

```text
Contexto: vamos a lanzar una segunda marca, "Conversia" (conversia.cl), sobre esta misma
plataforma. TuBot sigue operando idéntico. Esta etapa hace que el backend sepa a qué
marca pertenece cada organización y use los textos/links/remitentes correctos, SIN
cambiar nada del comportamiento actual de TuBot (todos los defaults = TuBot). No crea
ninguna UI nueva. Es la etapa F1 del plan docs/PROMPTS_CONVERSIA.md; la arquitectura
está en docs/CONVERSIA_MONTAJE.md (§3).

Lee antes de escribir código: CLAUDE.md, docs/CONVERSIA_MONTAJE.md, packages/config/src/index.ts.

REGLAS
· Regla de oro: si una organización no tiene marca, se comporta EXACTAMENTE como hoy
  (marca tubot). Ningún tenant existente debe notar cambio alguno.
· Prohibido if (org === ...) — la marca es un dato, la config de marca es un mapa.
· NO tocar apps/web (panel TuBot) salvo que el typecheck lo exija (no debería).
· Un solo PR, CI verde.

TAREA 1 — Columna brand en Organization
· Migración Prisma: `brand String @default("tubot")` en Organization
  (packages/database/prisma/schema.prisma, modelo en línea ~362), con @@index([brand]).
· Exponer brand en los endpoints que devuelven la organización (me/organization).

TAREA 2 — Mapa de marcas en packages/config
· Nuevo módulo brands.ts en packages/config/src con:
    export interface BrandConfig { key: string; name: string; webUrl: string;
      mailFrom: string; mfaIssuer: string; paymentSubjectPrefix: string;
      userAgent: string; logoPath: string }
    export const BRANDS: Record<string, BrandConfig>
  con dos entradas: tubot (valores ACTUALES: RESEND_FROM "TuBot <no-reply@tubot.cl>"
  línea ~74, VAPID_SUBJECT ~89, SUPER_ADMIN_MFA_ISSUER "TuBot.cl" ~115, WEB_URL) y
  conversia (WEB_URL_CONVERSIA nueva env, default https://app.conversia.cl;
  "Conversia <no-reply@conversia.cl>"; "Conversia.cl").
· Helper brandOf(org: { brand?: string | null }): BrandConfig con fallback a tubot.
· Nueva env WEB_URL_CONVERSIA validada con zod (opcional; si falta, la marca conversia
  usa WEB_URL — así dev/staging no se rompen).

TAREA 3 — Usos por marca (buscar TODAS las ocurrencias, lista de partida)
· CORS múltiple: apps/api/src/main.ts (~línea 39) acepta [WEB_URL, WEB_URL_CONVERSIA].
· Correos: remitente y links deben salir de brandOf(org) — apps/api/src/billing/
  payment-provider.ts (asuntos "TuBot — Plan X", líneas ~73 y ~166-170),
  platform.controller.ts (links de reseteo ~514-517), apps/worker/src/exports.ts
  (~121), mailer/channel-auth (asuntos "— TuBot"), invitaciones y links del montaje
  asistido.
· Retornos de Flow: la URL de retorno del checkout usa brandOf(org).webUrl.
· packages/agents/src/tools.ts: firma "Agendado por TuBot" (~271) y la descripción de
  getPlanes → usar el nombre de la marca del tenant.
· Auditar el resto con grep -ri "tubot" en apps/api, apps/worker, packages — lo que sea
  texto visible para el tenant o sus clientes pasa por brandOf(org); lo interno
  (nombres de jobs, comentarios) se deja.
· El MFA issuer del Super Admin NO cambia (es de plataforma, no de tenant).

TAREA 4 — Pruebas
· Test unitario de brandOf (org sin marca → tubot; conversia → config conversia).
· Test de que un correo de pago para una org tubot conserva EXACTAMENTE el asunto
  actual (regresión) y para una org conversia usa el nuevo.

Criterio de aceptación: pnpm typecheck && pnpm test verdes; cero cambios de
comportamiento para organizaciones sin brand o con brand=tubot.
```

---

## PROMPT F2 — Motor de paquetes verticales

```text
Contexto: Conversia vende la plataforma empaquetada por rubro (dental, barbería, ...).
Hoy existe una capa de rubro liviana (apps/api/src/common/industries.ts: vocabulario y
módulo agenda) y plantillas de agentes/flujos escritas a mano en el FRONTEND
(apps/web/src/lib/agent-templates.ts, workflow-templates.ts, industry-templates.ts),
que se instalan a medias desde settings/personalization. Esta etapa construye el motor
real: paquetes verticales versionados en BD que se instalan completos en una
transacción. Es la etapa F2 de docs/PROMPTS_CONVERSIA.md; el concepto está en
docs/CONVERSIA_VERTICALES.md (§2 y Fase 1).

Lee antes de escribir código: CLAUDE.md, docs/CONVERSIA_VERTICALES.md,
packages/database/src/seed.ts, apps/api/src/common/industries.ts,
apps/api/src/organizations/onboarding.controller.ts.

REGLAS
· El paquete instala DATOS, jamás código. Prohibido if (vertical === ...) en lógica.
· Todo dentro de withTenant y en UNA transacción: o se instala todo o nada.
· Idempotente: reinstalar el mismo paquete/versión no duplica nada (upsert por slug).
· Los agentes del paquete se crean como BORRADOR + versión publicable; los flujos como
  BORRADOR (el equipo o el montaje asistido publica tras personalizar).
· Un solo PR, CI verde.

TAREA 1 — Modelo
· Nueva tabla vertical_templates (migración Prisma): key (p.ej. "dental"), version
  (int), name, definition Json, active, createdAt. Única (key, version). Es global
  (sin organization_id), gestionada por Super Admin.
· definition reutiliza el FORMATO de los seeds (packages/database/src/seed.ts carga:
  leadStatuses, services, professionals?, tags, agents, workflows, knowledge,
  businessHours, vocabulary overrides, modules) — extraer de seed.ts las funciones de
  carga reutilizables a un módulo compartido en packages/database/src para no duplicar
  lógica CLI/API.

TAREA 2 — Instalador
· Servicio installVerticalPackage(orgId, key, version?) en apps/api (módulo
  organizations): transaccional, idempotente, registra en settings de la org
  { vertical: { key, version, installedAt } } y aplica el rubro (industries.ts) que
  el paquete declare.
· Endpoint POST /onboarding/vertical { key } (tenant, rol admin) + endpoint Super
  Admin POST /platform/organizations/:id/vertical { key, version }.
· El checklist de onboarding (onboarding.controller.ts) reconoce el paso "paquete
  vertical instalado".

TAREA 3 — Registro con rubro
· registerSchema (apps/api/src/auth/auth.service.ts ~33) acepta vertical opcional;
  si viene y existe plantilla activa, se instala el paquete tras crear la org (misma
  transacción o job inmediato con reintento).
· apps/web/src/app/registro/page.tsx: soporta ?vertical= (solo pasar el valor;
  la UI nueva llega en F3 — no rediseñar el registro actual).

TAREA 4 — Rubros nuevos y migración de plantillas
· FUENTE DE VERDAD DE RUBROS: docs/CONVERSIA_RUBROS.md (catálogo maestro del
  2026-10-02 con ranking, olas y las BASES de cada rubro: vocabulario, módulos,
  embudo, flujos, HSM, campos custom y KPIs). Sembrar en industries.ts las claves
  de TODAS las olas (1–3) con su vocabulario; respetar las notas de "variant"
  (leads/mesas/intake/estadias/pedidos) y las brechas técnicas listadas en su §3.
· Sembrar vertical_templates v1 completas para ola 1 (barberia, peluqueria,
  estetica, centro_medico, dental) + ola 2 (medspa, veterinaria, kinesiologia,
  gimnasio, taller, servicios_domicilio, psicologia), y como "beta" (instalables
  solo desde la consola del equipo) las de ola 3. Contenido inicial: portar las
  plantillas Dental de apps/web/src/lib/workflow-templates.ts + bases del catálogo;
  el contenido fino se mejora en F6. Incluir "generico".
· Marcar los archivos *-templates.ts del frontend como deprecados (comentario), sin
  romper la página de personalización actual.

Criterio de aceptación: crear una org de prueba con vertical=barberia deja: etapas,
etiquetas, servicios de ejemplo, agente borrador con prompt del rubro, flujos borrador,
vocabulario y módulos aplicados — verificable por API en una sola llamada.
```

---

## PROMPT F3 — `apps/conversia-web`: MVP con design system propio

```text
Contexto: Conversia necesita una interfaz TOTALMENTE nueva, moderna y enfocada por
vertical — no una copia del panel TuBot. Decisión de arquitectura (docs/
CONVERSIA_MONTAJE.md §6): nueva app Next.js DENTRO del monorepo, tratada como si fuera
un repo aparte. Esta etapa crea la app con su design system y las pantallas del MVP,
consumiendo la MISMA API. Es la etapa F3 de docs/PROMPTS_CONVERSIA.md. El brief de
diseño (paleta, tipografía, estilo) lo entrega el dueño antes de partir (Etapa 0).

Lee antes de escribir código: CLAUDE.md, docs/CONVERSIA_MONTAJE.md (§2 y §6),
docs/CONVERSIA_COSTOS.md (§0 — el widget de créditos es requisito), apps/web/package.json
(solo para replicar tooling, no UI).

REGLAS
· apps/conversia-web NUEVA. PROHIBIDO importar desde apps/web: agregar regla ESLint
  no-restricted-imports que lo bloquee (y nada de copiar componentes con estilos).
  Solo se importa de packages/* (@conversia/types principalmente).
· Design system propio en src/design, según el BRIEF DE DISEÑO decidido el 2026-09-30
  (referencia visual: artifact "Direcciones visuales Conversia" v5):
  - Identidad "Nocturna": modo oscuro = grafito azulado profundo con luz ambiental
    sutil (se apaga con prefers-reduced-motion), tarjetas de vidrio esmerilado
    (blur + borde hairline + highlight superior); modo claro = EL MISMO layout y
    componentes con piel de porcelana luminosa (tarjetas blancas translúcidas,
    sombras suaves). El modo es SOLO un set de tokens — jamás dos layouts.
  - Tipografía: Fraunces (display serif; marca, saludos con cursiva, titulares) +
    Inter (cuerpo, tablas, números tabulares).
  - ACENTO CONFIGURABLE POR USUARIO (feature de producto, decisión del dueño): paleta
    curada de ~6 acentos seguros (Menta #2DD4BF, Ártico, Índigo, Lima, Oro, Coral),
    cada uno con su set completo de tokens para ambos modos (acc, acc-deep, acc-ink,
    dim, line, glows). Se persiste en las preferencias del usuario (API) y tiñe
    navegación, botones, anillos, luz ambiental y marca. Nunca color libre: solo la
    paleta curada (garantiza contraste y elegancia).
  - ACENTO POR DEFECTO SEGÚN PAÍS (decisión del dueño 2026-10-01): el default se
    resuelve con Organization.country al crear la cuenta (mapa en config, editable
    sin deploy; el usuario siempre puede cambiarlo después). Mapa propuesto:
    CL → Menta · AR → Ártico (celeste) · CO → Oro · MX → Lima · PE → Coral ·
    resto LATAM/otros → Índigo. Regla: el mapa vive junto al mapa de marcas
    (packages/config) y el fallback global es Menta.
  - Detalles de producto del brief: línea "AHORA · hh:mm" en la agenda con citas
    pasadas atenuadas, anillos SVG de créditos/ocupación, sparkline en caja,
    indicador vivo "tu asistente está atendiendo", topbar con campana y avatar.
  - El indicador de CRÉDITOS es SEMÁNTICO, nunca del acento del usuario (decisión
    2026-09-30): gradiente verde→ámbar→rojo según consumo, con el porcentaje
    coloreado por tramo (<60% verde, 60–85% ámbar, >85% rojo) — el usuario debe
    entender de un vistazo que se acerca al límite.
  Cero Tailwind config compartida con apps/web.
· Arquitectura de información por vertical, no por módulo: la home es "el día de tu
  negocio" (hoy: agenda del día, conversaciones que esperan, caja/cobros, alertas),
  no un menú de 40 herramientas.
· NAVEGACIÓN UNIFICADA (decisión del dueño 2026-10-01, misma en TODAS las pantallas):
  - Escritorio/tablet (≥620px): riel de iconos fijo a la izquierda (Hoy,
    Conversaciones, Agenda, Clientes, Cobros) con tooltips, logo arriba y avatar
    del usuario abajo. Nunca una barra superior en unas pantallas y lateral en
    otras.
  - Móvil (<620px): el riel desaparece y la navegación pasa a una BARRA DE
    PESTAÑAS INFERIOR (Hoy · Chats con globo de pendientes · Agenda · Clientes ·
    Más), patrón de app convencional. En el chat abierto a pantalla completa, la
    barra inferior se oculta.
· SALUDO SEGÚN LA HORA del negocio (su zona horaria): "Buenos días" antes de las
  12:00, "Buenas tardes" 12:00–19:59, "Buenas noches" desde las 20:00 — siempre
  con el nombre del usuario ("Buenos días, Matías").
· Mobile-first real (los dueños de barbería viven en el teléfono). PWA como apps/web.
· La app se registra en turbo/pnpm workspace y en dev corre junto al resto (pnpm dev).
· Un PR por bloque de pantallas si crece mucho; CI verde siempre.

TAREA 1 — Scaffold + auth (IDENTIDAD ÚNICA — requisito del dueño 2026-09-30)
· Next.js (misma versión que apps/web), puerto propio (3002), envs propias
  (NEXT_PUBLIC_API_URL). Login contra la API existente (JWT igual que apps/web pero
  implementación propia y mínima).
· DEPLOY EN RAILWAY (decisión de arquitectura — NO crear un proyecto nuevo):
  - Se usa el MISMO proyecto Railway existente donde ya corren api, worker, web
    (TuBot), Postgres y Redis. Conversia NO tiene backend propio: comparte la
    MISMA api, el MISMO worker y la MISMA base de datos (un backend, dos
    frontends — docs/CONVERSIA_MONTAJE.md).
  - Lo ÚNICO nuevo es UN servicio adicional en ese proyecto: "conversia-web",
    apuntando al MISMO repo/monorepo, build filtrado a apps/conversia-web
    (turbo/pnpm --filter), autodeploy desde main como los demás servicios.
  - Dominio del servicio nuevo: app.conversia.cl. Envs del servicio: solo las del
    frontend (NEXT_PUBLIC_API_URL apunta a la api EXISTENTE). En la api se agrega
    WEB_URL_CONVERSIA (F1) para CORS y links — no se duplica ninguna otra env.
  - Prohibido: segundo Postgres, segundo Redis, segunda api o worker. Si alguien
    propone "separar el proyecto para Conversia", la respuesta es no (eso sería
    la opción clon, descartada en CONVERSIA_MONTAJE.md §1).
  - Documentar el servicio nuevo en docs/DEPLOYMENT.md (nombre, build command,
    dominio, envs).
· La cuenta es de PLATAFORMA, no de marca: el mismo correo entra a TuBot y a Conversia,
  y desde una cuenta se gestionan varias organizaciones (selector multi-cuenta como el
  del panel TuBot). Verificar cómo modela hoy la plataforma la membresía usuario↔orgs
  y reutilizarla tal cual — NO crear un sistema de usuarios paralelo.
· El selector de conversia-web lista las orgs del usuario con brand=conversia; si el
  usuario también tiene orgs tubot, mostrar acceso "Ir a TuBot" (link a WEB_URL) y
  viceversa en apps/web cuando tenga orgs conversia (cambio mínimo permitido en
  apps/web: solo ese acceso en el selector de cuentas).
· Registro por vertical: /registro?vertical=dental|barberia con selección visual del
  rubro si no viene el parámetro (usa F2).

TAREA 2 — Pantallas MVP (en este orden)
1. Home "hoy": agenda del día + conversaciones pendientes de humano + saldo de
   créditos + accesos rápidos.
2. Bandeja de conversaciones (SSE como el panel actual, misma API) — PATRÓN WHATSAPP
   (decisión del dueño 2026-10-01, referencia visual: artifact v8):
   · Escritorio: rail de iconos + lista de chats a la izquierda (avatar, nombre,
     ÚLTIMO MENSAJE debajo con prefijo "Asistente:" y ticks cuando lo envió el bot,
     ícono de canal si no es WhatsApp, hora; hora en ámbar + globo numerado cuando
     espera a un humano) + conversación a la derecha (fondo con textura sutil,
     burbujas con hora y ticks adentro, eventos del bot como tarjetas en el hilo,
     interruptor "IA activa", botón "Tomar conversación"). Ficha del cliente en
     panel lateral QUE SE ABRE con "Ver ficha", no fija.
   · Móvil: exactamente como WhatsApp — se ve la lista; tocar un chat abre la
     conversación a pantalla completa con flecha para volver (master-detail).
   · Breakpoint (precisión del dueño 2026-10-01): el navegador SIEMPRE muestra los
     dos paneles (lista izquierda + chat derecha), aunque la ventana sea mediana —
     solo se compacta la lista. El master-detail móvil aplica únicamente bajo
     ~620px (ancho de teléfono real).
   · BARRA DE OPERACIÓN sobre el hilo (requisito del dueño 2026-10-01, "lo más
     completo posible"; todo existe en la API):
     - Chip "Agente: <nombre> ▾": muestra qué agente IA atiende la conversación
       (conversations.active_agent_id) y permite cambiarlo entre los agentes
       publicados del tenant (mecánica de transferToAgent desde el panel).
     - Chip "Asignada a: <miembro> ▾": derivar la conversación a cualquier usuario
       del equipo (asignación + notificación al asignado).
     - Chip "Etapa ▾" (updateLeadStatus) y "+ Etiqueta" (addTag) inline.
     - Indicador de VENTANA 24h de WhatsApp con tiempo restante (verde); al
       cerrarse cambia a estado "ventana cerrada → enviar plantilla HSM".
   · En el hilo: tarjetas de evento del bot (agendó, cobró, transfirió) y NOTAS
     INTERNAS (burbuja ámbar punteada, solo visibles para el equipo).
   · Redactor: adjuntar, respuestas rápidas (Snippets), agendar cita (agenda
     nativa), enviar link de pago (tool charging), alternar nota interna, enviar.
   · Header: buscar en la conversación + menú ⋯ (marcar no leída, archivar,
     cerrar/resolver). "Tomar conversación" / interruptor "IA activa" como estaba.
   · Filtros de lista: Todos / Esperándote / Con IA / No leídos.
3. Agenda: vista día/semana, crear/mover cita, personas/recursos (API agenda nativa
   existente: apps/api/src/scheduling/agenda.controller.ts).
4. Clientes: lista + ficha + embudo simple (etapas del paquete vertical).
5. Facturación: plan actual, CONTADOR DE CRÉDITOS (saldo, consumo del mes por
   categoría, proyección de agotamiento, alerta visual al 80% — datos de
   MessageWallet/WalletLedger vía API; si falta endpoint de resumen, crearlo en
   apps/api/src/billing), compra de sobres de 500 créditos, historial de pagos.
6. Ajustes esenciales: horarios, servicios/precios, equipo, datos del negocio.
   Incluye la pantalla de CONFIGURACIÓN DE AGENDA (requisito del dueño 2026-10-01):
   horarios por persona/recurso día por día (bloques, pausas, día libre),
   excepciones (feriados, vacaciones, bloqueos puntuales), duración y margen por
   servicio, y anticipación mínima — todo contra la API de agenda nativa existente
   (apps/api/src/scheduling/agenda.controller.ts ya expone el CRUD de config).
   SIN editor de agentes ni de flujos: el cliente Conversia no configura bots
   (decisión de negocio) — mostrar "Tu asistente" en solo-lectura amable (qué hace,
   estado) con CTA "solicitar un cambio" (crea SupportTicket).

TAREA 3 — Identidad
· Layout, manifest, íconos y metadata propios de Conversia (assets del brief de
  diseño; placeholder temporal si aún no están). Legales de Conversia en /legal.

Criterio de aceptación: flujo completo demo en local — registro con vertical,
paquete instalado, home con agenda y bandeja funcionando contra la API, contador de
créditos visible con datos reales del wallet, y cero imports desde apps/web
(lint lo prueba).
```

---

## PROMPT F4 — Agenda nativa completa

```text
Contexto: la agenda nativa (packages/scheduling/src/index.ts, provider NATIVA ~213)
hoy NO implementa reagendar, cancelar ni confirmar (lanzan "aún no disponible",
líneas ~284-294), y los flujos de recordatorio ya ofrecen botones Confirmar/Reagendar
(apps/worker/src/appointment-responses.ts). Para el vertical barbería/peluquería esto
es bloqueante. Esta etapa completa el proveedor nativo. Es la etapa F4 de
docs/PROMPTS_CONVERSIA.md.

Lee antes de escribir código: CLAUDE.md, docs/SCHEDULING.md, packages/scheduling/src/
(index.ts y availability.ts), apps/worker/src/appointment-reminders.ts y
appointment-responses.ts, apps/api/src/scheduling/agenda.controller.ts.

REGLAS
· Respetar el contrato SchedulingProvider de @conversia/types — los otros providers
  (Cláriva, Dentalink, custom, mock) no se tocan.
· Anti doble reserva: reagendar valida disponibilidad con la misma lógica de
  availability.ts dentro de una transacción (bloqueo optimista o unique existente).
· Idempotencia: confirmar dos veces no duplica eventos; cancelar una cita cancelada
  es no-op con respuesta amable.
· Un solo PR, CI verde, con tests del motor puro (reagendar a slot ocupado falla).

TAREA 1 — Implementar en el provider NATIVA: rescheduleAppointment,
cancelAppointment, confirmAppointment (+ registrar no-show como estado si el contrato
lo contempla; si no, meta.attendance).
TAREA 2 — Conectar los botones de respuesta del recordatorio (Confirmar/Reagendar)
al provider nativo cuando la conexión activa sea nativa; el flujo de reagendo por
chat ofrece los próximos slots disponibles (availability existente).
TAREA 3 — Espejo Google Calendar: reflejar cambios/cancelaciones (apps/worker,
lógica de espejo existente).
TAREA 4 — UI: en el panel actual (apps/web) habilitar las acciones si el provider
las soporta (capability check, no hardcodeo); conversia-web (F3) las consume igual.

Criterio de aceptación: ciclo completo por WhatsApp simulado (scripts/
simulate-inbound.mjs): agendar → recordatorio → reagendar por chat → confirmar →
cancelar, todo contra la agenda nativa y reflejado en el espejo de Google.
```

---

## PROMPT F5 — Planes Conversia en BD + setup + sobres

```text
Contexto: la estructura comercial de Conversia está cerrada en docs/CONVERSIA_COSTOS.md
(§0): setup obligatorio ($190.000 lanzamiento), Funcionando $149.900 (1.500 créditos),
Gestionado $299.900 (4.000 créditos), Custom a cotización, sobre de 500 créditos a
$21.900, pesos de bolsa utilidad/servicio/auth 1 · marketing 4, IA sin tope comercial
(fusible interno aiTokensDaily). Esta etapa materializa eso en el catálogo de planes y
la bolsa. Requiere mergeadas E1–E3 (medidor de servicio) y F1 (marca). Es la etapa F5
de docs/PROMPTS_CONVERSIA.md.

Lee antes de escribir código: CLAUDE.md, docs/CONVERSIA_COSTOS.md, docs/
PLANS_AND_LIMITS.md, docs/PREPAID_WALLET_DESIGN.md, packages/database/src/seed.ts
(planes ~309-346), apps/api/src/billing.

REGLAS
· Los planes Conversia son filas nuevas del catálogo (codes conversia_funcionando,
  conversia_gestionado, conversia_custom), isPublic=false en la web TuBot (la landing
  Conversia los muestra por marca). NO tocar los planes TuBot existentes (decisión
  2026-09-30: TuBot queda como está).
· Precios en BD, etiquetables "lanzamiento"; grandfathering: el cambio de precio de un
  plan NO afecta suscripciones activas (si el modelo actual no lo garantiza,
  implementarlo aquí — es el pendiente E4 de billing en versión mínima).
· Un solo PR, CI verde.

TAREA 1 — Seeds/config de los 3 planes con priceClp y priceUsd (159/319/529 ref.),
limits (users, channels, clinics según vertical; aiTokensDaily generoso como fusible),
features { managed: true|false }, y créditos mensuales de bolsa (1.500/4.000/a medida)
acreditados por el ciclo de suscripción existente.
TAREA 2 — Setup fee: producto de cobro único por marca/vertical usando el mecanismo
de link de pago del Super Admin (PR #378) + estado "pendiente de implementación" en la
org hasta marcar pagado; el registro Conversia queda en modo "espera de activación"
(sin trial 7+7 — el ciclo de Conversia parte cuando el equipo entrega).
TAREA 3 — Sobre de 500 créditos a $21.900 (MessagePackage) comprable desde la API;
pesos de bolsa por categoría sembrados 1/1/1/4 para orgs brand=conversia (configurable
en Super Admin, ya soportado).
TAREA 4 — Endpoint de resumen de consumo para el contador (si no salió en F3):
GET /billing/wallet/summary → saldo, consumo del mes por categoría, proyección simple
(promedio diario × días restantes), umbral 80% cruzado sí/no. Alertas al 80% por
correo/push reutilizando el sistema de notificaciones.

Criterio de aceptación: una org conversia de prueba puede: quedar creada con plan
Funcionando pendiente de setup → marcar setup pagado → ciclo activo con 1.500 créditos
→ consumir → alerta al 80% → comprar sobre de 500 → ver todo en el resumen.
```

---

## PROMPT F6 — Contenido de verticales piloto + tenant comercial Conversia

```text
Contexto: con el motor F2 funcionando, esta etapa carga el CONTENIDO real de los dos
verticales piloto (dental y barbería) y monta el tenant comercial de Conversia (ventas
e implementación), replicando el patrón del tenant TuBot (docs/TUBOT_TENANT.md) con el
montaje asistido. Es la etapa F6 de docs/PROMPTS_CONVERSIA.md. Requiere F2 mergeada;
ideal F1 (marca) para los textos.

Lee antes de escribir código: CLAUDE.md, docs/TUBOT_TENANT.md, docs/RUTA_MONTAJE.md,
packages/database/seeds/digital-dent.json (referencia de estructura — NO copiar datos
del cliente), apps/worker/src/assisted-setup.ts, packages/agents/src/tools.ts.

REGLAS
· Contenido en español de Chile, por vertical, SIN datos de clientes reales (destilar
  la ESTRUCTURA de lo aprendido con Digital-Dent, jamás precios/nombres/textos suyos).
· El grant de montaje asistido hoy apunta a UNA org proveedora (envs en
  packages/config/src/index.ts ~57-58): parametrizar por marca (proveedor TuBot para
  orgs tubot, proveedor Conversia para orgs conversia), con fallback al actual.
· Un solo PR de código + seeds; el afinamiento de prompts puede iterar después.

TAREA 1 — vertical_templates v2 "dental" y "barberia" completos: etapas de embudo del
rubro, campos custom, etiquetas, servicios de ejemplo con duraciones, horarios
típicos, FAQ base (knowledge), agente principal con prompt del nicho (tono, objeciones
típicas, política de no inventar precios — regla 3 de CLAUDE.md), flujos: recordatorio
+ confirmación, no-show/reactivación, bienvenida/calificación, post-atención con
solicitud de reseña. Guía HSM del rubro (template-guide.ts ya soporta rubros).
TAREA 2 — Nueva tool installVerticalPackage en packages/agents/src/tools.ts (registro
+ zod + permisos ToolContext), disponible SOLO para el agente de implementación vía
grant de montaje — docs/RUTA_MONTAJE.md pide además completar los alcances declarados:
implementar upsertKnowledge y publishFlow acotadas al grant, y reincorporarlas al
prompt del agente de implementación.
TAREA 3 — Tenant comercial Conversia: seed JSON (org brand=conversia) con agentes
comercial (por vertical: conoce SOLO los planes Conversia de F5 vía getPlanes),
implementación (Opus, con las tools de montaje) y soporte — prompts base nuevos,
inspirados en la estructura de los de TuBot (packages/database/scripts/
gen-tubot-agents-sql.mjs como referencia de formato, generalizado sin ORG_ID
hardcodeado).

Criterio de aceptación: demo de punta a punta en staging — lead entra por WhatsApp al
tenant Conversia, el agente comercial vende el vertical barbería, se crea la org con
el paquete instalado, el agente de implementación completa el montaje con sus tools y
el cliente queda operando en conversia-web.
```

---

## PROMPT F7 — Soporte in-app con IA + continuidad por WhatsApp

```text
Contexto: el cliente Conversia debe poder pedir ayuda SIN salir del panel: una burbuja
flotante abre un chat atendido por el agente de soporte IA del tenant proveedor
(Conversia), con número de ticket, y puede continuar la misma conversación por
WhatsApp sin que el bot pierda el contexto (p. ej. si hay que reiniciar el navegador).
Es la etapa F7 de docs/PROMPTS_CONVERSIA.md. Piezas existentes a reutilizar: tabla
SupportTicket y su enrutamiento, el agente de soporte del tenant proveedor
(docs/TUBOT_TENANT.md), el patrón de vinculación por código del montaje asistido
(TB-XXXX) y toda la infraestructura de conversaciones/orquestador.

Lee antes de escribir código: CLAUDE.md, docs/TUBOT_TENANT.md §7, docs/RUTA_MONTAJE.md,
apps/worker/src/assisted-setup.ts, el flujo de mensajes entrantes del worker.

REGLAS
· El chat de soporte es una CONVERSACIÓN NORMAL en la org proveedora (brand-aware,
  F1): mismo orquestador, mismas trazas, misma bandeja — el equipo Conversia la ve
  y puede tomarla como cualquier otra. Nada paralelo.
· Aislamiento: el agente de soporte puede leer el estado del tenant consultante vía
  las tools de grant acotado ya existentes (getClientSetupState); JAMÁS datos de
  otros tenants. El contexto del ticket (org, plan, vertical, versión) se inyecta
  server-side, nunca lo declara el cliente.
· Persistencia server-side: el hilo NO depende del navegador. Al abrir el widget,
  GET /support/active devuelve el ticket abierto del usuario (si existe) con su
  historial — reiniciar el navegador retoma donde quedó.

TAREA 1 — Canal webchat
· Enum de canal WEBCHAT (migración). Mensajería: POST /support/messages (autenticado
  como usuario del tenant) crea/continúa la conversación en la org proveedora con
  contacto = identidad del usuario (nombre, email, teléfono si existe); respuestas
  del agente vía el stream SSE existente.
TAREA 2 — Ticket y continuidad
· Al crear la conversación: SupportTicket con código CV-XXXX (mismo generador de
  códigos del montaje), visible en el widget ("Ticket CV-1042").
· Botón "Seguir en WhatsApp": link wa.me del número de soporte Conversia con texto
  prellenado "CV-1042 — continuar mi caso". El webhook entrante detecta el código,
  vincula la conversación de WhatsApp al MISMO ticket y el agente recibe el
  historial del widget como contexto (resumen inyectado al prompt) — continuidad
  real entre navegador y WhatsApp.
· El mismo código funciona a la inversa (empezó por WhatsApp, sigue en el panel).
TAREA 3 — Widget en conversia-web
· Burbuja flotante (abajo derecha, respeta el design system y el acento del
  usuario); panel con historial, estado del ticket, "Seguir en WhatsApp" y
  calificación al cerrar. Escalamiento: si el agente transfiere a humano, notifica
  al equipo Conversia (bandeja + push).
TAREA 4 — Pruebas: reiniciar sesión del navegador y retomar; saltar a WhatsApp con
el código y verificar que el agente conserva el contexto; aislamiento entre tenants.
```

## PROMPT F8 — El dueño administra su agenda por el bot (tools de horarios)

```text
Contexto: el dueño del negocio debe poder pedirle al bot, por WhatsApp, cambios de
agenda — "Tomás no atiende mañana", "agrega a Caro de 10 a 14 los sábados", "corre
mi hora de colación a las 14" — y también hacerlo desde la pantalla de Ajustes de
agenda (F3). Hoy las tools de IA son de LECTURA + crear cita; no existen tools de
administración. Es la etapa F8 de docs/PROMPTS_CONVERSIA.md. Requiere F4 (agenda
nativa completa).

Lee antes de escribir código: CLAUDE.md, docs/AGENTS.md, packages/agents/src/tools.ts,
packages/scheduling, docs/SCHEDULING.md, apps/api/src/scheduling/agenda.controller.ts.

REGLAS (seguridad primero)
· GUARDIA DE IDENTIDAD: estas tools solo se habilitan cuando el CONTACTO de la
  conversación es un USUARIO del tenant con rol admin/owner (teléfono verificado
  vinculado a su cuenta — nueva verificación ownerContext en ToolContext). Un
  cliente final JAMÁS las ve ni las puede invocar. Doble cerrojo: habilitación por
  versión de agente (solo el agente del dueño las tiene) + verificación en runtime.
· Toda escritura pasa por la MISMA lógica del agenda.controller (validaciones,
  anti doble reserva) — la IA no escribe directo en BD (regla 4 de CLAUDE.md).
· Confirmación en dos pasos para cambios destructivos: el bot resume el cambio
  ("Tomás queda sin atención mañana jueves; hay 3 citas afectadas — ¿las
  reagendo o las cancelo avisando a los clientes?") y ejecuta solo tras el OK.
· Auditoría: cada cambio registra quién (usuario), qué y desde dónde (chat/panel).

TAREA 1 — Tools nuevas en packages/agents/src/tools.ts (zod + permisos):
  updateProfessionalSchedule (horario semanal/bloques por persona),
  addProfessionalTimeOff (vacaciones/bloqueos/feriado con manejo de citas
  afectadas), upsertProfessional (alta/baja de quien atiende),
  updateBusinessHours (horario del local), updateServiceConfig (duración/precio).
TAREA 2 — ownerContext: resolución teléfono→usuario→rol en el worker al armar el
  ToolContext; tests de que un contacto no-dueño no recibe las tools.
TAREA 3 — Flujo de citas afectadas: al bloquear horario con citas existentes, el
  bot ofrece reagendar (slots alternativos) o cancelar con aviso automático a cada
  cliente (plantilla/ventana según corresponda).
TAREA 4 — Habilitar las tools en el agente del paquete vertical (F2/F6) solo para
  el modo dueño, y documentar en el prompt del agente los límites y el tono.
```

## PROMPT F9 — Módulo de recaudación y caja (flujos de dinero)

```text
Contexto: Conversia necesita un módulo de RECAUDACIÓN Y CAJA: registrar todo el
dinero que entra al negocio (pagos por link Flow/Getnet que ya existen, efectivo,
transferencia, tarjeta presencial) y salidas simples, con cierre de caja diario y
reportes. MANEJA DINERO: el diseño prioriza integridad y auditabilidad por sobre la
conveniencia, sin excepciones. Es la etapa F9 de docs/PROMPTS_CONVERSIA.md.

Lee antes de escribir código: CLAUDE.md, docs/BILLING.md (cobros del tenant a sus
clientes), apps/api/src/charging/, apps/worker/src/customer-charge.ts y
getnet-charge.ts, tabla CustomerPayment, docs/SUPER_ADMIN_AUDIT.md.

REGLAS NO NEGOCIABLES
1. LIBRO APPEND-ONLY: tabla cash_ledger INMUTABLE. Prohibido UPDATE/DELETE de
   asientos: un error se corrige con un ASIENTO DE REVERSA que referencia al
   original. Hacerlo imposible A NIVEL DE BASE DE DATOS (revocar UPDATE/DELETE al
   rol de la app sobre esa tabla en sql/setup.sql), no solo en la aplicación.
2. Montos en ENTEROS (CLP sin decimales; unidades menores si la moneda las tiene),
   con moneda explícita por asiento. JAMÁS float, jamás aritmética en JS con
   decimales.
3. Cada asiento registra: organizationId, tipo (ingreso|egreso|reversa), método
   (link_flow|link_getnet|efectivo|transferencia|tarjeta|otro), monto, moneda,
   referencia (appointmentId / contactId / concepto), createdById (usuario humano
   o 'system' solo para webhooks verificados), origen (panel|webhook),
   timestamp del SERVIDOR e idempotencyKey única por organización.
4. LA IA JAMÁS REGISTRA DINERO. El bot solo crea links de pago (tool existente).
   Un pago recibido lo registra: (a) un humano con el permiso nuevo cash.manage, o
   (b) el webhook verificado de Flow/Getnet (CustomerPayment pagado → asiento
   automático marcado CONCILIADO). Permiso cash.report para solo lectura. Las
   tools de IA no reciben ninguna capacidad de este módulo.
5. CIERRE DE CAJA DIARIO: snapshot inmutable (totales por método, efectivo
   declarado por conteo, diferencia calculada), con el usuario que cierra.
   Reabrir = evento auditado que genera un NUEVO cierre; el anterior no se toca.
6. Conciliación visible SIEMPRE: los reportes distinguen conciliado (webhook) vs
   declarado (manual) en todos los totales.
7. Alcance: caja operativa del negocio. NADA de contabilidad tributaria/DTE
   (decisión previa) ni de tocar la facturación de la suscripción Conversia
   (ese es otro sistema: billing de plataforma).
8. Tests exhaustivos y obligatorios: reversa y re-reversa; idempotencia (doble
   click y webhook duplicado); cierre con diferencia de efectivo; permisos por
   rol; aislamiento RLS entre tenants; y una property-test: la suma de asientos
   del período SIEMPRE cuadra con el total reportado.

TAREA 1 — Migración: cash_ledger + cash_closures con constraints y revocación de
  UPDATE/DELETE; índices por (organizationId, createdAt) y por referencia.
TAREA 2 — API: crear ingreso manual / egreso / reversa; cierre del día; reportes
  día/semana/mes por método y por profesional/servicio (vía referencia); export CSV.
TAREA 3 — Asiento automático desde CustomerPayment pagado (idempotente por
  paymentId) — nada de doble registro si el webhook se repite.
TAREA 4 — UI conversia-web (pantalla Cobros/Caja): caja del día (alimenta también
  el KPI del Hoy), registrar pago manual (monto, método, vínculo a cita/cliente),
  egreso, cierre de caja guiado paso a paso, historial con filtros.
TAREA 5 — Auditoría: todo al audit log. El Super Admin VE reportes agregados pero
  NO puede crear, editar ni revertir asientos de ningún tenant.

Criterio de aceptación: imposible modificar o borrar un asiento ni desde la API ni
desde SQL con el rol de la app; un día completo simulado (links + efectivo + egreso
+ reversa + cierre) cuadra al peso en el reporte y distingue conciliado/declarado.
```

## PROMPT F10 — Consola de operación Conversia (back-office del equipo)

```text
Contexto: Conversia es llave en mano — TODO el trabajo que en TuBot hace el cliente
(conectar el número de WhatsApp, configurar agentes de IA, flujos, agenda, catálogo)
en Conversia lo hace NUESTRO equipo por detrás. El cliente solo usa la plataforma y
pide ajustes (a su agente de soporte o al equipo). Esta etapa construye la consola
con la que el equipo opera esa implementación a escala, y le da al agente de soporte
(F7) el CONTEXTO COMPLETO del cliente para resolver rápido. Es la etapa F10 de
docs/PROMPTS_CONVERSIA.md. Base existente a reutilizar: el Super Admin actual
(apps/api/src/platform/platform.controller.ts: impersonación, provisión de demos,
config por org, link de pago), el montaje asistido (AssistedSetupGrant + tools), el
instalador de paquetes verticales (F2) y el checklist de onboarding.

Lee antes de escribir código: CLAUDE.md, docs/SUPER_ADMIN_SECURITY.md,
docs/SUPER_ADMIN_AUDIT.md, docs/TUBOT_TENANT.md §7, docs/RUTA_MONTAJE.md,
apps/api/src/platform/, apps/api/src/organizations/onboarding.controller.ts.

REGLAS
· ROL NUEVO "OPERADOR" de plataforma (migración): el equipo de implementación opera
  clientes SIN ser Super Admin. Puede: ver cartera, operar la ficha de clientes
  (agentes, flujos, números, paquetes, agenda, catálogo), impersonar CON auditoría.
  NO puede: tocar platform_settings globales, planes/precios, fusibles, otros
  operadores, ni nada de billing de plataforma. Hoy "el Super Admin es la llave de
  todo" es un riesgo conocido (RISK_REGISTER): esta separación lo mitiga.
· TODA acción de operador queda en el audit log (quién, qué cliente, qué cambió) —
  mismo estándar de SUPER_ADMIN_AUDIT.md.
· La consola vive en el panel de plataforma existente (apps/web/src/app/admin — esta
  etapa SÍ puede tocarlo: es su objeto) con marca visual Conversia/TuBot por org.
· Nada hardcodeado por cliente (regla 2 de CLAUDE.md): la consola configura DATOS.

TAREA 1 — Cartera de implementación
· Vista lista de organizaciones (filtro por marca/vertical/estado) con semáforo de
  implementación por cliente: WhatsApp conectado y sano · agente publicado · flujos
  activos · agenda/horarios cargados · catálogo (si aplica al vertical) · pruebas
  hechas · GO-LIVE. Estado derivado del checklist de onboarding existente +
  salud del número (WhatsappPhoneNumber) — no de un campo manual.
· Columnas operativas: días desde el alta, setup pagado (F5), consumo de créditos
  del mes, tickets abiertos, margen del tenant (si F9/reportes disponibles).
TAREA 2 — Ficha de operación del cliente (una sola pantalla, todo a la mano)
· Resumen: org, marca, vertical+versión del paquete, plan/suscripción/setup, país.
· Canales: WABA y números con salud, calidad y plantillas (estado de sync); acceso
  al Embedded Signup para conectar el número EN NOMBRE del cliente (link
  compartible o flujo guiado).
· IA: agentes del tenant (versión publicada, modelo, costo del mes), editar/probar
  (editor existente), instalar/actualizar paquete vertical (F2), knowledge.
· Flujos: lista con estado y últimas ejecuciones fallidas.
· Operación: últimas conversaciones con error/derivación, integrationEvents
  recientes, tickets F7 del cliente (con su historial).
· Acciones rápidas auditadas: impersonar · reinstalar plantillas HSM · re-sync ·
  pausar/reactivar bot · generar link de pago.
TAREA 3 — Alta guiada (wizard interno "nuevo cliente Conversia")
· Encadena lo que ya existe en un solo flujo para el operador: crear/validar org
  (brand, país→acento, vertical) → instalar paquete (F2) → conectar WhatsApp →
  personalizar agente (desde la plantilla del vertical + notas de la entrevista) →
  cargar servicios/horarios (o delegarlo al bot de implementación, montaje
  asistido) → probar con el simulador → checklist GO-LIVE → marcar ENTREGADO
  (dispara la activación del ciclo de cobro de F5 si el setup está pagado).
TAREA 4 — Contexto total para el agente de soporte (enlace con F7 — CRÍTICO)
· Server-side: buildClientContext(organizationId) → resumen estructurado que se
  inyecta al prompt del agente de soporte al abrir/retomar un ticket: vertical y
  paquete, plan y estado de pago, salud del número y ventana de plantillas, agentes
  y última versión publicada, flujos activos, consumo de créditos (y si está al
  80%+), últimos integrationEvents de error, tickets previos del cliente y su
  resolución. SOLO del tenant del ticket (aislamiento F7).
· Tools de soporte de SOLO LECTURA sobre ese tenant (getClientContext,
  getRecentErrors, getConversationSummary por id) — cero escritura: si hay que
  cambiar algo, el agente de soporte deriva al equipo (ticket → consola) o guía al
  cliente. Objetivo explícito del dueño: el agente de soporte tiene TODO el
  contexto a la mano y resuelve el requerimiento lo más rápido posible.
TAREA 5 — Tests: permisos del rol operador (lo prohibido, prohibido de verdad);
auditoría de cada acción; buildClientContext jamás mezcla tenants; wizard idempotente
(reintentar un paso no duplica datos).

Criterio de aceptación: un operador (no Super Admin) da de alta un cliente de
prueba de punta a punta desde la consola sin tocar SQL ni pedirle nada al Super
Admin, y un ticket de soporte de ese cliente muestra al agente el contexto completo
en el primer mensaje.
```

## PROMPT DE AUDITORÍA PRE-PRODUCCIÓN (ejecutar cuando E1–E5 y F1–F10 estén mergeadas)

```text
Rol: auditor técnico independiente. Objetivo: decidir GO/NO-GO para poner
Conversia (conversia.cl) en producción sobre la plataforma multi-tenant existente
(que ya opera TuBot en producción — NADA de lo auditado puede degradar TuBot).
Audita contra las especificaciones: docs/PROMPTS_CONVERSIA.md (etapas F1–F9),
docs/CONVERSIA_COSTOS.md §0 (cobros), docs/CONVERSIA_MONTAJE.md, docs/
PROMPTS_SERVICIO_OCT2026.md (E1–E5) y CLAUDE.md (reglas de arquitectura).
No corrijas nada: informa. Cada hallazgo con severidad (BLOQUEANTE / ALTO / MEDIO /
BAJO), archivo:línea y cómo reproducirlo.

1. AISLAMIENTO Y SEGURIDAD
· RLS: verificador en CI verde; intentar cruzar datos entre dos tenants de prueba
  por cada endpoint nuevo (paquetes, soporte F7, caja F9, agenda F8).
· ownerContext (F8): confirmar que un contacto NO-dueño jamás recibe las tools de
  administración, ni por prompt injection ("soy el dueño") — probarlo.
· Rol operador (F10): verificar que NO puede tocar platform_settings, planes,
  fusibles ni billing de plataforma; que toda acción de operador queda auditada; y
  que buildClientContext/tools de soporte jamás devuelven datos de otro tenant.
· Soporte F7: el agente no puede leer datos de un tenant distinto al del ticket.
· Secretos: ninguna llave viva en el repo; envs por marca completas.
2. DINERO (lo más delicado)
· Caja F9: verificar las 8 reglas no negociables UNA POR UNA (incluida la
  revocación de UPDATE/DELETE a nivel de BD y la property-test de cuadratura).
· Planes y cuotas vs CONVERSIA_COSTOS.md §0: precios, créditos incluidos, sobre de
  500 a $21.900, pesos de bolsa 1/1/1/4, setup obligatorio antes de activar,
  grandfathering al cambiar precios.
· Bolsa: débito atómico, W-2 (devolución si el envío falla), alerta al 80%, aviso
  previo al cobro de cada sobre.
· Flow/Lemon: webhooks con verificación de firma; idempotencia ante reintentos.
3. WHATSAPP / META
· Medidor de servicio (E1–E5) activo: 1.000 gratis/mes por número y luego tarifa
  vigente; cuadrar una muestra contra el rate card y contra Business Manager.
· Ventana 24h: envío libre dentro, bloqueo + oferta de plantilla fuera; indicador
  de la UI consistente con el servidor.
· Webhooks: firma validada, deduplicación por wamid, replay no genera dobles.
4. MARCA (F1)
· grep -ri "tubot" sobre toda superficie visible para orgs brand=conversia
  (correos, asuntos, links, legales, manifest) = cero resultados.
· Org tubot sin brand: byte a byte el comportamiento actual (regresión).
· CORS, retornos de Flow, OAuth y links de correo correctos por marca.
5. PRODUCTO (F2–F8 contra sus specs)
· Paquete vertical: instalación transaccional e idempotente; registro con
  ?vertical=; contenido dental/barbería sin ningún dato de Digital-Dent.
· conversia-web: navegación unificada (riel/tab bar, breakpoints 620/980), saludo
  por hora con zona horaria del negocio, créditos semánticos verde→ámbar→rojo con
  tramos 60/85, acento por usuario persistido, lint que prohíbe importar de
  apps/web, PWA instalable, contador de créditos con proyección.
· Bandeja: cambio de agente, asignación a equipo, etapa/etiquetas, ventana 24h,
  notas internas, master-detail móvil.
· F7: reinicio de navegador retoma ticket; salto a WhatsApp con CV-XXXX conserva
  contexto; F4: ciclo completo agendar→reagendar→confirmar→cancelar por chat.
6. OPERACIÓN
· Prueba de carga básica (objetivo: 50 tenants chicos concurrentes sin degradar
  latencia de respuesta del bot); WORKER_CONCURRENCY y pool de BD revisados.
· Backup + RESTORE probado de verdad; runbook de incidentes; rollback de deploy
  documentado; alertas (system_alerts) llegando a alguien.
7. CHECKLIST DE CONEXIONES A PRODUCCIÓN (verificar hecho, no prometido)
· DNS conversia.cl + app.conversia.cl → Railway; TLS ok.
· Resend: dominio conversia.cl verificado (SPF/DKIM) y no-reply operativo.
· Servicios Railway: conversia-web desplegada; envs por marca; WEB_URL_CONVERSIA.
· Flow producción (y Lemon si LATAM día 1) con llaves reales y retorno correcto.
· Meta: número de producción del tenant Conversia, plantillas aprobadas, webhooks.
· Legales publicados en conversia.cl; tenant proveedor Conversia operativo con
  sus 3 agentes publicados.

8. FLUJO REDONDO — ANÁLISIS DE BRECHAS (tu segundo mandato, tan importante como
   los 7 anteriores: NO asumas que el plan está completo)
· Recorre de punta a punta los CUATRO viajes y marca todo paso que no tenga dueño,
  pantalla, API o procedimiento definido:
  (a) Viaje del CLIENTE: lo conocen (ads/landing/comercial) → le venden → paga el
      setup → lo implementan (wizard F10) → GO-LIVE → usa a diario (Hoy, chats,
      agenda, caja) → pide un cambio (soporte F7 / bot F8) → consume de más
      (alertas, sobres) → paga cada mes → renueva o se quiere ir (baja, datos,
      número, permanencia).
  (b) Viaje del OPERADOR: recibe el alta → implementa → entrega → monitorea
      cartera → atiende escalamientos → detecta tenant con margen malo → actúa.
  (c) Viaje del DINERO: setup → mensualidad → consumo (créditos/Meta) → excedente
      → mora/dunning → reembolso/reversa → baja. Cada peso debe tener asiento,
      responsable y reporte.
  (d) Viaje del DATO: alta → datos del negocio y sus clientes finales → quién los
      ve (equipo, IA, operador) → export → retención → purga tras la baja.
· Verifica una a una las brechas YA identificadas en la sección "Qué queda fuera"
  (offboarding/WABA, enforcement de permanencia, migración TuBot↔Conversia, MFA
  del operador, status page bi-marca, DTE): para cada una debe existir al menos el
  camino manual documentado y la confirmación del dueño de que así se lanza; si no,
  es hallazgo (severidad según riesgo).
· Todo hueco NUEVO que descubras (un paso de los viajes sin resolver, un estado sin
  transición, un "¿y si...?" sin respuesta) va al informe en una sección propia
  "BRECHAS DEL FLUJO" con severidad y propuesta mínima para cerrarlo.

ENTREGABLE: informe en docs/AUDITORIA_PREPROD_CONVERSIA.md — resumen GO/NO-GO,
tabla de hallazgos por severidad, sección BRECHAS DEL FLUJO (punto 8), y la lista
exacta de bloqueantes con su fix sugerido. Sin bloqueantes abiertos no se lanza;
con bloqueantes, re-auditar solo los puntos afectados tras corregir.
```

## Funcionalidades específicas por rubro (para los paquetes verticales de F6)

**Barbería / peluquería** (v1 = lanzamiento, v2 = después de 5 clientes):
- v1: horarios por barbero administrables por bot (F8) · re-reserva cíclica ("ya
  pasaron 3 semanas de tu último corte, ¿agendamos?") · reserva con seña vía link
  de pago para horas conflictivas (anti no-show, usa charging) · lista de espera
  cuando el horario pedido está lleno (aviso automático si se libera) · venta de
  productos (pomadas/shampoo) por catálogo en el chat.
- v2: comisiones por barbero (requiere modelo nuevo) · fidelización (cada N cortes,
  uno con descuento) · galería de estilos.

**Dental** (v1):
- Triage de urgencias en el prompt (dolor agudo/trauma → prioridad + cupo de
  urgencia + derivación a humano) · recall de higiene/control cada 6 meses
  (workflow) · seguimiento de presupuestos no aceptados (recordatorio suave a los
  X días) · post-operatorio automático (indicaciones + check al día siguiente) ·
  abono/seña de tratamientos por link de pago · integración Cláriva/Dentalink como
  "sistema clínico" (ya existe).
- v2: confirmación de controles multi-cita (tratamientos largos) · comunicación de
  resultados de laboratorio ("tu prótesis llegó").

**Servicios a domicilio / técnicos** (v1):
- Pre-cotización por foto (el cliente manda foto del problema → el bot la describe
  y arma pre-cotización que un humano aprueba antes de enviarse) · agendamiento con
  dirección y validación de zona de cobertura · anticipo por link de pago ·
  recordatorio "el técnico va en camino" (estado manual desde el panel) ·
  post-servicio con garantía y solicitud de reseña.
- v2: ruta del día para el técnico (orden de visitas) · checklist de trabajo
  terminado con fotos.

**Transversal a todos los rubros**: solicitud de reseña Google post-atención ·
recuperación de conversaciones abandonadas (CTWA sigue gratis 72h) · informe
semanal al dueño por WhatsApp (citas, caja, conversaciones atendidas por la IA).

## Qué queda fuera (consciente, para después — el auditor DEBE confirmar que cada
## punto sigue siendo aceptable al momento del lanzamiento)

- Landing pública conversia.cl con páginas por vertical y checkout (tras F5; puede ser
  proyecto aparte tipo `digital-dent-sitio`). Mientras no exista: la venta la cierra
  el agente comercial + alta por wizard F10.
- Campañas Meta por vertical (playbook `TUBOT_META_ADS_PLAN.md` adaptado).
- Caja/comisiones de barbería, pedidos/stock ferretería (v2 del producto).
- Reporte de margen por tenant en Super Admin (guardrail §7.4 de CONVERSIA_COSTOS.md).
- White-label multi-dominio completo (resolución de marca por host) — no hace falta
  con dos apps separadas; revisar solo si aparece una tercera marca.

Brechas identificadas en la revisión del 2026-10-01 (decididas como "para después",
pero el flujo debe tener al menos el camino manual documentado antes de lanzar):
- **OFFBOARDING / baja de un cliente Conversia**: qué pasa con su WABA/número (la
  portabilidad del número es del cliente — documentar el procedimiento de handover),
  export de sus datos (exports.ts existe), plazo de retención y purga post-baja
  (hoy solo existe purga de trial). Mínimo para lanzar: procedimiento escrito.
- **Enforcement de la permanencia** (6 meses): hoy sería manual (no cobrar la
  salida anticipada automáticamente). Mínimo: cláusula en el contrato + proceso.
- **Mecanismo de migración TuBot↔Conversia** (decisión: ambas direcciones): cambiar
  brand + plan + panel no está construido como flujo; mínimo: runbook manual del
  operador (cambios por Super Admin) hasta que exista como feature.
- **MFA obligatorio para el rol operador** (F10): el Super Admin ya lo tiene; el
  operador debe tenerlo igual — si no entró en F10, es bloqueante de auditoría.
- **Status page / comunicación de incidentes bi-marca**: una caída golpea a ambas
  marcas a la vez; mínimo: plantillas de comunicación y canal definido por marca.
- **Boleta/factura por el servicio Conversia (DTE)**: fuera de alcance por decisión
  previa — el auditor confirma que el dueño mantiene la decisión al lanzar.
