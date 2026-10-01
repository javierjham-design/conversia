> **[2026-10-01] Integrado a `PROMPTS_CONVERSIA.md` (plan maestro E1–E5 + F1–F9). Usar la versión de allá; esta copia queda como referencia histórica.**

# Prompts de desarrollo — cobro de mensajes de servicio (octubre 2026)

Plan de implementación segmentado en **5 etapas mergeables**, en orden de dependencia,
derivado de la auditoría del 2026-08-31 (artifact «TuBot Octubre 2026»). Cada etapa es
un prompt autocontenido para una sesión de desarrollo en VS: se pega tal cual, sin
depender del contexto de otra sesión.

## Orden y dependencias

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

## Checklist operativo del dueño (no es prompt — va en paralelo)

- [ ] **OK-1**: correr las consultas de solo lectura en prod → cifra bloque 1 + lista 6.1 + línea base 4.4.
- [ ] **OK-8 / A3**: decidir tarjeta-del-cliente vs OBO (define la variante del correo de E5 y el riesgo del 30-09).
- [ ] **1-sep**: rate card definitivo de Meta → confirmar USD 0,0200 CL y la etiqueta de categoría del webhook (checklist en BILLING.md tras E1).
- [ ] **OK migración E3** + aplicar por runbook (backup doble + migrate deploy + setup.sql + smoke).
- [ ] **Sembrar** `whatsappRateSchedule` (CL service 0,02 @ 2026-10-01T00:00:00Z), techos svc del fusible, y features de cupo por plan (con la cifra).
- [ ] **OK-7**: aplicar el seed regenerado de agentes TuBot a prod (E4 y E5 lo dejan listo).
- [ ] **OK-4/OK-5** (opcionales): endpoint hard-cap por tenant en platform + service en la calculadora del admin.
- [ ] **22-30 sep**: disparar el aviso a clientes (script de E5) + verificación final de medios de pago por WABA (6.1/6.2).
