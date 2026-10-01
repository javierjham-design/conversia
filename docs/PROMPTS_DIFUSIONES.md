# Prompts de desarrollo — Difusiones (envío masivo de plantillas de WhatsApp)

Caso que lo origina: una empresa con **2.000 trabajadores** necesita enviarles
información institucional por WhatsApp. Hoy la plataforma NO tiene envío masivo:
las plantillas salen una a una (bandeja), por workflows (triggers por evento) o
recordatorios. La función nueva — **Difusiones** — orquesta el envío de UNA
plantilla aprobada a una audiencia (todos / segmento / etiqueta), con ritmo
controlado, pausas inteligentes y seguimiento, **pasando cada mensaje por
`chargeTemplateSend`** (bolsa + fusible + topes): no se abre ninguna puerta nueva
de gasto, solo se orquesta.

Auditado contra el repo el 2026-09-01 (main). Referencias `archivo:línea` a esa
fecha; si una línea se movió, manda el símbolo.

## Qué YA existe y se reutiliza (verificado)

| Pieza | Dónde | Uso en Difusiones |
|---|---|---|
| Compuerta de plantillas (6 condiciones: capacidad del plan, switch por tenant, demo/gracia/suspensión, tope diario, bolsa atómica idempotente, fusible global) | `apps/worker/src/messaging-guard.ts` → `chargeTemplateSend` | Se llama POR MENSAJE, sin tocarla |
| Patrón completo de envío de plantilla (validar APPROVED, params, render, gate, provider, estados, `integrationEvent`) | `apps/worker/src/workflow-runtime.ts:374-474` (`sendTemplate` del motor) | Se calca |
| Crear/reutilizar conversación para contacto frío | `apps/worker/src/workflow-runtime.ts:35-61` `ensureConversationForContact` (hoy NO exportada) | Exportarla y reutilizar |
| Reembolso de bolsa idempotente | `apps/worker/src/wallet.ts:183-201` `refundForMessage` | En fallo terminal de Meta |
| Audiencia por segmento/etiqueta → `where` Prisma | `apps/api/src/contacts/contacts.controller.ts:116-173` (`buildWhere` + `resolveWhere`) | Extraer a helper compartido |
| **Importación CSV de contactos (hasta 10.000 filas)** | cola `contact-imports` + `processContactImport` (worker `main.ts:88-92`); body en `contacts.controller.ts:101-112` | Los 2.000 trabajadores se cargan HOY, sin código nuevo |
| Plantillas aprobadas del tenant | `GET /channels/templates/approved` (`channels.controller.ts:842`) | Selector del wizard |
| Saldo de bolsa del tenant | `GET /billing/wallet` (`billing.controller.ts:289`) | Estimación en el wizard |
| Catálogo de notificaciones (evento nuevo = 1 entrada + `enqueueNotification`) | `packages/notifications/src/catalog.ts` (patrón `wallet.low` :177-186) | `broadcast.done` / `broadcast.paused` |
| Registro de colas | `QUEUE_NAMES` en `packages/types/src/index.ts:402-417` · `Queue` en `apps/api/src/queues.ts` (+ `onModuleDestroy`) · `Worker` en `apps/worker/src/main.ts:62-136` | Cola nueva `broadcast-dispatch` |
| Estados entregado/leído por webhook (statuses → messages) | `apps/worker/src/inbound.ts:149-163` | El progreso "entregado/leído" sale gratis |
| Tope diario por tenant ajustable por Super Admin | `PATCH /platform/organizations/:id/messaging-cap` (ya existe) | Subirlo ANTES de una difusión de 2.000 |
| Patrón de tests (funciones puras, vitest) | `apps/worker/src/contact-capture.test.ts` | `broadcast-plan.test.ts` |
| Permisos | `requirePermission("contacts:read"/"contacts:write")`; owner/admin = `*` | Lectura / mutaciones |
| Nav del panel | `apps/web/src/app/(app)/layout.tsx` (~:229-273 items `{href,label,icon,perm}` + `BREADCRUMBS` :275+) | Ítem «Difusiones» en Operación |
| Cliente API del front | `apps/web/src/lib/api.ts` (`api<T>(path, init)`) | Páginas nuevas |

## Segmentación y orden

| Prompt | Qué | Depende de | Migración |
|---|---|---|---|
| **D1** | Modelo + cola + worker + API + notificaciones + tests + docs | nada (feature aislada) | **sí (1, con OK del dueño)** |
| **D2** | UI del panel (/broadcasts: lista, wizard, detalle) + nav | D1 mergeada (o su contrato de API) | no |

D1 y D2 pueden desarrollarse en paralelo (el contrato de API está fijado en ambos
prompts); D2 se prueba de verdad cuando D1 está desplegada.

---

## CHECKLIST OPERATIVO — empezar HOY, no espera al código

Lo que bloquea el envío real NO es el desarrollo: son aprobaciones y límites de
Meta que toman días. En paralelo al desarrollo:

1. **Plantilla**: redactar y enviar a aprobación (Canales → Plantillas) la
   plantilla del comunicado, categoría **UTILITY** — contenido informativo a
   empleados con relación existente, sin promociones. Si Meta la clasifica
   MARKETING cuesta 4,4× ($78,49 vs $17,66 CLP por mensaje: $157.000 vs $35.300
   por difusión de 2.000). Aprobación: de minutos a 48 h. Consejo: variable
   {{1}} = nombre, cuerpo neutro reutilizable («Hola {{1}}, te compartimos
   información de [Empresa]: …»).
2. **Verificación del negocio en Meta** (Business Manager → Centro de seguridad):
   sin ella el número queda en tier de **250 conversaciones únicas/24 h**. Con
   ella parte en **1.000/24 h** y escala automático (10K → 100K) con volumen y
   calidad. Para 2.000 el primer día se necesita tier ≥10K **o** repartir en 2
   días (tier 1K) — la función lo maneja sola (pausa por tope y reanuda), pero
   hay que saberlo para prometer fechas.
3. **Importar los 2.000 trabajadores**: la importación CSV YA existe (Contactos →
   Importar; hasta 10.000 filas; columnas nombre/apellido/teléfono/email/
   etiquetas). Subirlos con una etiqueta dedicada (p. ej. «empleados-empresa-X»)
   — esa etiqueta será la audiencia de la difusión.
4. **Opt-in y bajas**: la política de Meta exige consentimiento previo del
   destinatario para mensajes iniciados por el negocio. La empresa debe tener el
   opt-in documentado (cláusula interna / firma / correo). Las bajas se marcan
   en la ficha del contacto («No contactar») y las difusiones los excluyen
   automáticamente.
5. **Capacidad en la plataforma** (Super Admin): subir el **tope diario** del
   tenant a ≥2.500 (`PATCH /platform/organizations/:id/messaging-cap`) y
   verificar que el techo del **fusible global** lo soporte; cargar **bolsa**
   suficiente (2.000 créditos por difusión; el plan Enterprise trae 4.000/mes —
   dimensionar plan/paquetes según frecuencia: 1 difusión quincenal = 4.000/mes).
6. **Calidad del número**: monitorear el quality rating en WhatsApp Manager tras
   cada difusión; si baja a "rojo", espaciar los envíos. El ritmo por defecto de
   la función (30/min ≈ 67 min para 2.000) es deliberadamente conservador.

---

## PROMPT D1 — Difusiones: modelo, worker, API (backend completo)

```text
Contexto: la plataforma necesita DIFUSIONES — envío masivo de UNA plantilla de
WhatsApp aprobada a una audiencia del tenant (todos los contactos / un segmento /
una etiqueta), con ritmo controlado, pausas inteligentes, reanudación, seguimiento
por destinatario y notificaciones al terminar. Caso real que lo origina: un tenant
(empresa) necesita comunicar información institucional a sus 2.000 trabajadores
(ya cargados como contactos vía importación CSV). Este prompt es el backend
completo; la UI es otro prompt (D2) y su contrato de API está fijado aquí — no lo
cambies sin anotarlo en la entrega.

Lee antes de escribir código: CLAUDE.md, docs/PREPAID_WALLET_DESIGN.md,
docs/WHATSAPP.md, docs/MULTITENANCY.md, docs/DEPLOYMENT.md (runbook de migración),
y los archivos citados abajo ANTES de tocarlos.

PRINCIPIO RECTOR: la difusión NO abre ninguna vía nueva de gasto. Cada mensaje
pasa por chargeTemplateSend (apps/worker/src/messaging-guard.ts) — las 6
condiciones existentes (capacidad del plan, switch por tenant, demo/gracia/
suspensión, tope diario, bolsa prepagada atómica, fusible global) aplican
INTACTAS. La difusión solo orquesta: materializa destinatarios, da ritmo,
interpreta los bloqueos del gate y reporta. PROHIBIDO tocar chargeTemplateSend,
debitForMessage, la cola "outbound" del panel o las políticas de la bolsa.

REGLAS
· MIGRACIÓN: hay UNA (2 tablas). Escríbela, muéstrala con su plan de reversa y
  ESPERA EL OK EXPLÍCITO del dueño en la conversación antes de aplicarla fuera de
  tu entorno local. En prod rige el runbook de docs/DEPLOYMENT.md (doble backup +
  prisma migrate deploy + REEJECUTAR sql/setup.sql porque hay tablas nuevas con
  organization_id → heredan RLS y FK dinámica + smoke test).
· NO tocar apps/web/src/app/admin ni apps/api/src/platform.
· Multi-tenancy: todo acceso vía withTenant / this.prisma.withTenant; el
  organizationId JAMÁS viene del cliente; los jobs llevan organizationId en el
  payload (reglas de CLAUDE.md).
· No romper: 6 compuertas, bolsa, fusible, aislamiento (verify:isolation), colas
  existentes, montaje asistido. Español de Chile. CI verde (pnpm typecheck &&
  pnpm test). Un PR.

TAREA 1 — Migración (packages/database): 2 tablas ADITIVAS
Modelos Prisma (status como String, igual que WhatsappTemplate.status — sin
enums nuevos):

  model Broadcast {
    id              String    @id @default(cuid())
    organizationId  String    @map("organization_id")
    name            String
    templateId      String    @map("template_id")
    audience        Json      @default("{}")   // { kind: "all"|"segment"|"tag", segmentId?, tagId? }
    status          String    @default("DRAFT") // DRAFT|SCHEDULED|RUNNING|PAUSED|DONE|CANCELLED
    pausedReason    String?   @map("paused_reason")
    pacePerMinute   Int       @default(30) @map("pace_per_minute")
    scheduledAt     DateTime? @map("scheduled_at")
    startedAt       DateTime? @map("started_at")
    finishedAt      DateTime? @map("finished_at")
    totalRecipients Int       @default(0) @map("total_recipients")
    createdById     String?   @map("created_by_id")
    createdAt       DateTime  @default(now()) @map("created_at")
    updatedAt       DateTime  @updatedAt @map("updated_at")
    @@index([organizationId, status])
    @@map("broadcasts")
  }

  model BroadcastRecipient {
    id             String    @id @default(cuid())
    organizationId String    @map("organization_id")
    broadcastId    String    @map("broadcast_id")
    contactId      String    @map("contact_id")
    status         String    @default("PENDING") // PENDING|SENT|FAILED|SKIPPED
    reason         String?                        // motivo de SKIPPED/FAILED
    messageId      String?   @map("message_id")
    processedAt    DateTime? @map("processed_at")
    @@unique([broadcastId, contactId])            // idempotencia del fan-out
    @@index([organizationId, broadcastId, status])
    @@map("broadcast_recipients")
  }

Carpeta de migración con el formato del repo (YYYYMMDDHHMMSS_broadcasts).
Reversa (déjala como comentario en la migración y en la entrega):
DROP TABLE broadcast_recipients; DROP TABLE broadcasts; — aditiva, ningún código
previo las lee. Tras migrar en local: pnpm db:setup + verify:isolation en verde.

TAREA 2 — Cola nueva (packages/types + apps/api + apps/worker)
· packages/types/src/index.ts: QUEUE_NAMES.broadcast = "broadcast-dispatch"
  (:402-417) y el tipo del job:
    export interface BroadcastJob {
      organizationId: string;
      broadcastId: string;
      /** al despertar, reabrir SOLO si sigue pausada por este mismo motivo */
      resumeIfPausedFor?: string;
    }
· apps/api/src/queues.ts: Queue nueva `broadcast` (patrón de las existentes) +
  incluirla en onModuleDestroy.
· apps/worker/src/main.ts: Worker nuevo sobre QUEUE_NAMES.broadcast →
  processBroadcastTick, concurrency 1 (una tanda a la vez por diseño; el ritmo
  lo da el tick, no el paralelismo).

TAREA 3 — Audiencia compartida (apps/api/src/contacts)
buildWhere + resolveWhere viven dentro de contacts.controller.ts (:116-173).
Extráelos SIN CAMBIAR COMPORTAMIENTO a apps/api/src/contacts/contact-query.ts y
haz que el controller los importe (typecheck confirma que nada más cambió). La
audiencia de una difusión se resuelve con ese mismo helper:
  audience {kind:"all"} → buildWhere({}) ; {kind:"segment"} → definición del
  segmento ; {kind:"tag"} → tagContactIds (patrón resolveWhere :166-171).
Filtros SIEMPRE añadidos encima, no negociables: deletedAt null, phone != null,
blocked false, doNotContact false.

TAREA 4 — API (apps/api/src/broadcasts/broadcasts.controller.ts, registrar en
app.module.ts). Contrato FIJO (D2 lo consume):
· GET  /broadcasts → { items: [{ id, name, status, pausedReason, pacePerMinute,
  scheduledAt, startedAt, finishedAt, totalRecipients, counts: { pending, sent,
  failed, skipped }, createdAt }] } — counts por groupBy de recipients.
· GET  /broadcasts/audience-count?kind=&segmentId=&tagId= → { count } (aplica los
  filtros no negociables; el wizard lo muestra en vivo).
· POST /broadcasts { name, templateId, audience, pacePerMinute?, scheduledAt? }
  → valida con zod (name 1-80; pace 6-60; audience por kind; template existe,
  es del tenant y status APPROVED — patrón workflow-runtime :389-392) → crea
  DRAFT y devuelve { id, audienceCount, estimatedCredits, estimatedCostUsd }:
  estimatedCredits = audienceCount × peso de la categoría (lee
  platform_settings.walletWeights, default 1) y estimatedCostUsd = audienceCount
  × computeWhatsappCostUsd(template.category, org.country) (import de
  @conversia/agents, patrón notifications.controller.ts:246).
· POST /broadcasts/:id/start → solo desde DRAFT/SCHEDULED. Materializa
  destinatarios si no existen: contactos del where de audiencia en lotes de
  1.000 (findMany select id + createMany BroadcastRecipient skipDuplicates),
  totalRecipients = count; si scheduledAt es futuro → status SCHEDULED y encola
  el job con delay hasta esa hora; si no → status RUNNING + startedAt + encola
  el job ya. Auditar (audit_logs) quién lo inició.
· POST /broadcasts/:id/pause → RUNNING→PAUSED (pausedReason "manual").
· POST /broadcasts/:id/resume → PAUSED→RUNNING + encola tick. Si pausedReason
  era "no_balance", igual se permite (el tenant compró paquete).
· POST /broadcasts/:id/cancel → DRAFT/SCHEDULED/RUNNING/PAUSED→CANCELLED (los
  PENDING no se tocan: quedan como historial de no-enviados).
· POST /broadcasts/:id/test { phone } → envía la plantilla UNA vez al teléfono
  indicado por el flujo real (contacto de prueba upsert por phone + conversación
  + gate + envío). Debita 1 de bolsa — honesto a propósito; dilo en la respuesta
  { ok, debited: true }.
· Permisos: GET con requirePermission("contacts:read"); mutaciones con
  "contacts:write". Validación zod con el patrón parse() del repo.

TAREA 5 — Worker (apps/worker/src/broadcast.ts + broadcast-plan.ts)
Separa LÓGICA PURA (broadcast-plan.ts, testeable sin BD) de EFECTOS
(broadcast.ts), patrón billing-dunning/state-machine del repo.

5a. Exporta ensureConversationForContact desde workflow-runtime.ts (:35) — solo
    agregar `export`, sin moverla ni cambiarla.

5b. processBroadcastTick(job: BroadcastJob):
  1. Carga el broadcast. Si no existe o CANCELLED/DONE → return.
  2. Si job.resumeIfPausedFor: si status === "PAUSED" && pausedReason ===
     job.resumeIfPausedFor → status RUNNING (auto-reanudación); si no → return
     (alguien lo canceló/reanudó a mano entre medio).
  3. Si status !== "RUNNING" → return (SCHEDULED despierta por el delay del
     job de start: al despertar, marca RUNNING y sigue).
  4. Toma la tanda: recipients PENDING, orderBy id asc, take pacePerMinute.
     Si 0 → status DONE + finishedAt + enqueueNotification "broadcast.done"
     (conteos por groupBy) → return.
  5. Procesa la tanda EN SECUENCIA (jamás Promise.all — es una ráfaga contra
     Meta y contra la BD), con un sleep corto entre envíos (≈ 60_000 /
     pacePerMinute ms, tope 2s) para suavizar el ritmo dentro del minuto.
  6. Al terminar la tanda sin pausa: si quedan PENDING → re-encolar
     { organizationId, broadcastId } con delay 5_000 (el ritmo real lo puso el
     sleep del paso 5; el tick corto evita colas de 1 h de delay) y jobId único
     por tick (p. ej. `bc:${broadcastId}:${Date.now()}` con removeOnComplete) —
     NUNCA un jobId fijo reutilizado (lección del envenenamiento de jobId
     documentada en queues.ts:50-55).

5c. Por DESTINATARIO (la decisión va en broadcast-plan.ts como función pura
    planRecipient(recipient, message, contact) → acción; los efectos en
    broadcast.ts):
  · Contacto inexistente, deletedAt, sin phone, blocked o doNotContact →
    recipient SKIPPED (reason corto: "sin_telefono" | "bloqueado" |
    "no_contactar") + processedAt. NO cuenta como fallo.
  · RECUPERACIÓN IDEMPOTENTE (el tick puede morir y reintentarse): si
    recipient.messageId existe, mira el message:
      - status SENT/DELIVERED/READ → recipient SENT (ya salió; no reenviar).
      - status PENDING → REINTENTA el envío con ESE MISMO messageId (el débito
        de bolsa es idempotente por messageId → no cobra dos veces).
      - status FAILED → crea un MESSAGE NUEVO y actualiza recipient.messageId.
        MOTIVO (no lo "simplifiques"): si el fallo anterior fue el fusible, el
        gate debitó y REEMBOLSÓ ese messageId; reintentar con el mismo id haría
        que debitForMessage respondiera "already" sin re-debitar → saldría
        GRATIS. Message nuevo = débito limpio.
  · Camino normal: ensureConversationForContact → crea message TEMPLATE PENDING
    (authorType SYSTEM, payload { templateId, broadcastId }) → gate =
    chargeTemplateSend(org, messageId, template.category).
  · Si gate.blocked, la política por gate.reason (función pura
    gatePolicy(reason) → { pause: boolean; autoResumeMs?: number }):
      - "no_balance"    → PAUSA la difusión, SIN auto-reanudación (requiere
        comprar paquete; el aviso wallet.empty ya sale solo). El recipient
        VUELVE a PENDING y el message queda FAILED con gate.userMessage.
      - "tenant_cap" | "global_fuse" → PAUSA con auto-reanudación: encola
        BroadcastJob con resumeIfPausedFor = reason y delay hasta las 00:05 del
        día siguiente (los contadores son por día).
      - "demo" | "suspended" | "grace" | "plan_no_templates" |
        "templates_switch_off" → PAUSA sin auto-reanudación (requiere acción
        humana/comercial).
      En TODA pausa: pausedReason = reason, recipient de vuelta a PENDING,
      enqueueNotification "broadcast.paused", integrationEvent
      "broadcast.paused" (patrón outbound.ts:108-117) y CORTA la tanda.
  · Si gate pasa: resolveTemplateParams + renderTemplateBody (calco EXACTO de
    workflow-runtime :393-396) → getChannelProvider().send con el token del
    canal de la conversación (resolveChannelAuth). Éxito → message SENT +
    externalId + sentAt; recipient SENT + processedAt.
  · Fallo del send:
      - ChannelAuthError / ChannelConfigError → afecta a TODO el resto: message
        FAILED, recipient PENDING de nuevo, PAUSA ("channel_auth" /
        "channel_config", sin auto-reanudación), markChannelAuthError /
        markChannelConfigError como hace outbound.ts:165-172, y corta.
      - Error con indicios de rate limit de Meta (el texto trae 130429, 131048
        o 131056) → PAUSA "meta_rate_limit" con auto-reanudación en 1 hora
        (resumeIfPausedFor), recipient PENDING de nuevo.
      - Otro error (red/5xx): reintenta 2 veces in-process con backoff 600ms×n
        (patrón agent-turn.ts:556-573). Si igual falla: message FAILED +
        recipient FAILED (reason = error corto) + refundForMessage(org,
        messageId) — devuelve el crédito del débito de ese mensaje (W-2, ya es
        idempotente) — y SIGUE con el próximo destinatario.
  · Cortacircuito de calidad: 10 FAILED consecutivos → PAUSA
    "too_many_failures" sin auto-reanudación (protege el quality rating del
    número y la bolsa). Contador en memoria del tick, se reinicia con un éxito.

TAREA 6 — Notificaciones (packages/notifications/src/catalog.ts)
Dos eventos (patrón wallet.low :177-186; audiencia ["owner","tenant_admins"],
channels in_app/web_push/email, defaults in_app/email, link "/broadcasts"):
· "broadcast.done"  (urgency info): título "Difusión completada" · body
  "«{name}»: {sent} enviados, {failed} fallidos, {skipped} omitidos de {total}."
· "broadcast.paused" (urgency critical): título "Difusión en pausa" · body
  "«{name}» se pausó: {reasonText}. Entra a Difusiones para revisarla."
  (reasonText en español claro por cada motivo — mapa en el worker).

TAREA 7 — Tests + matriz
· broadcast-plan.test.ts (puro, patrón contact-capture.test.ts):
  - planRecipient: contacto sin phone/bloqueado/no-contactar → SKIP con reason;
    message SENT previo → marcar sin reenviar; message PENDING → reintento mismo
    id; message FAILED → id nuevo (el caso refund-del-fusible documentado).
  - gatePolicy: cada reason → pausa correcta, auto-resume solo en tenant_cap/
    global_fuse/meta_rate_limit; no_balance jamás auto-reanuda.
  - detección de rate limit por códigos en el texto del error.
  - cálculo del sleep de pacing (60000/pace, tope 2s) y del delay a las 00:05.
· Validaciones del controller (zod): audiencia inválida, pace fuera de rango,
  plantilla no aprobada, transiciones de estado ilegales (start desde RUNNING,
  resume desde DONE, etc.).
· Matriz en docs/BROADCASTS.md (tabla caso → esperado → estado), mínimo: tanda
  respeta pace; difusión termina y notifica; sin saldo → pausa y al comprar +
  resume termina; tope diario → pausa y auto-reanuda al día siguiente; fusible
  → ídem; 10 fallos seguidos → pausa; cancelación a mitad; dos tenants con
  difusiones simultáneas no se mezclan (verify:isolation); reintento de tick
  tras crash no duplica envíos ni cobros; test send debita 1.

TAREA 8 — Documentación (docs/BROADCASTS.md, nuevo)
Arquitectura (tick + gate por mensaje + políticas de pausa), operación para el
Super Admin (subir dailyCap del tenant ANTES de una difusión grande; techo del
fusible global), límites de Meta (tiers 250/1K/10K/100K por verificación y
calidad; qué pasa al chocar: pausa y reanudación), costos (utility CL $17,66 ×
2.000 ≈ $35.300 CLP + 2.000 créditos de bolsa; MARKETING 4,4×), requisito de
opt-in y exclusión automática de "No contactar", y el runbook completo del caso
"2.000 trabajadores" (importar CSV con etiqueta → plantilla UTILITY aprobada →
subir topes/bolsa → prueba → difusión con pace 30/min).

ENTREGA (voy a auditar contra esto)
· Migración completa con reversa y estado del OK del dueño (dado/pendiente).
· Archivos tocados por tarea y decisiones (por qué message nuevo tras FAILED,
  por qué secuencial, por qué concurrency 1, por qué status String).
· Matriz de docs/BROADCASTS.md con resultados reales de los tests.
· pnpm typecheck + suite en verde; verify:isolation en verde tras migrar local.
· Confirmación explícita: chargeTemplateSend/debitForMessage/outbound del panel
  SIN cambios (solo el `export` de ensureConversationForContact en
  workflow-runtime).
```

---

## PROMPT D2 — Difusiones: UI del panel

```text
Contexto: el backend de Difusiones (envío masivo de plantillas de WhatsApp) está
definido/implementado con este contrato de API bajo /broadcasts (prompt D1):
lista GET /broadcasts (items con counts {pending,sent,failed,skipped}), conteo
GET /broadcasts/audience-count?kind=&segmentId=&tagId=, creación POST /broadcasts
{name, templateId, audience:{kind:"all"|"segment"|"tag", segmentId?, tagId?},
pacePerMinute?, scheduledAt?} → {id, audienceCount, estimatedCredits,
estimatedCostUsd}, acciones POST /broadcasts/:id/start|pause|resume|cancel, y
prueba POST /broadcasts/:id/test {phone}. Este prompt construye la UI del panel
del tenant. Nada de tocar backend salvo que un gap del contrato lo exija — si
pasa, anótalo en la entrega.

Lee antes: CLAUDE.md, apps/web/src/lib/api.ts (helper api<T>), una página de
referencia para calcar patrones visuales y de datos:
apps/web/src/app/(app)/channels/templates-panel.tsx (selector de plantillas +
entitlement) y apps/web/src/app/(app)/billing/wallet-card.tsx (bolsa). Componentes
compartidos en apps/web/src/components/ui.tsx. Clases del design system del repo
(text-ink, text-ink-muted, border-line, bg-brand-600, rounded-xl…): usa las
mismas, no inventes paleta nueva. Modo oscuro y responsive como el resto del
panel.

REGLAS
· NO tocar apps/web/src/app/admin ni nada de apps/api salvo gap de contrato.
· Textos en español de Chile, sin tecnicismos: la función se llama «Difusiones».
· Estados vacíos y de error cuidados (sin plantillas aprobadas, sin permiso,
  API caída). CI verde: pnpm typecheck && pnpm --filter @conversia/web build (la
  web tiene smoke e2e de robustez en CI — que las páginas nuevas no revienten
  con datos vacíos/null).

TAREA 1 — Navegación (apps/web/src/app/(app)/layout.tsx)
· Ítem «Difusiones» en la sección "Operación" (~:229-273), después de Clientes:
  { href: "/broadcasts", label: "Difusiones", icon: Megaphone, perm:
  "contacts:read" } (Megaphone de lucide-react, ya es dependencia).
· BREADCRUMBS (~:275+): "/broadcasts": ["Operación", "Difusiones"] y
  "/broadcasts/[id]" según el patrón dinámico existente.

TAREA 2 — Lista + creación (apps/web/src/app/(app)/broadcasts/page.tsx, client)
· Tabla/listado: nombre, chip de estado (DRAFT gris, SCHEDULED azul con fecha,
  RUNNING con spinner y "x de y", PAUSED ámbar con el motivo EN ESPAÑOL, DONE
  verde con resumen, CANCELLED gris), progreso (sent+failed+skipped)/total,
  fecha. Poll cada 5 s SOLO si hay alguna RUNNING (setInterval con cleanup).
· Botón «Nueva difusión» → wizard (modal o sección) con:
  1. Nombre.
  2. Plantilla: GET /channels/templates/approved (solo APPROVED; si la lista
     llega vacía → estado vacío con link a Canales → Plantillas y CTA
     deshabilitado). Muestra cuerpo y categoría de la elegida; si la categoría
     es MARKETING, advertencia de costo (cuesta ~4,4× una utility).
  3. Audiencia: radio Todos / Segmento (select de GET /contacts/segments) /
     Etiqueta (select de las etiquetas del tenant). Al cambiar, GET
     /broadcasts/audience-count y muestra «{count} destinatarios con WhatsApp
     válido (excluye bloqueados y "no contactar")».
  4. Ritmo: select 10 / 30 (recomendado) / 60 por minuto, con la duración
     estimada («2.000 al ritmo de 30/min ≈ 1 h 7 min»).
  5. Programación: «Enviar ahora» o datetime-local futuro.
  6. Resumen antes de confirmar: destinatarios, créditos de bolsa que usará
     (estimatedCredits) vs saldo actual (GET /billing/wallet) — si no alcanza,
     advertencia visible con link a /billing (no bloquees: el backend pausará
     con aviso, pero que nadie se sorprenda), costo Meta estimado
     (estimatedCostUsd) como referencia.
  7. «Enviar prueba a un número» (input tel + botón) → POST /broadcasts/:id/test
     con aviso «la prueba descuenta 1 mensaje de tu bolsa».
  8. Crear (queda DRAFT) y «Iniciar» (POST start) con confirmación explícita:
     «Vas a enviar “{plantilla}” a {count} contactos. Esto no se puede deshacer
     una vez enviados.»
· Permisos: si el usuario no tiene contacts:write, todo en solo-lectura (los
  botones de mutación ocultos, patrón del resto del panel).

TAREA 3 — Detalle (apps/web/src/app/(app)/broadcasts/[id]/page.tsx, client)
· Encabezado: nombre, chip de estado + motivo de pausa en español, plantilla y
  audiencia usadas, iniciado por / fechas.
· Progreso: barra + contadores Pendientes / Enviados / Fallidos / Omitidos (y
  entregados/leídos si el backend los expone). Poll cada 5 s mientras RUNNING.
· Acciones según estado: Pausar (RUNNING), Reanudar (PAUSED — si el motivo es
  "no_balance", el botón acompaña un link a /billing «compra un paquete
  primero»), Cancelar (con confirmación), Iniciar (DRAFT/SCHEDULED).
· Tabla de problemas: destinatarios FAILED y SKIPPED con nombre/teléfono y el
  motivo en español (paginada o "primeros 100 + contador").
· Estado terminal claro: DONE muestra el resumen final y cuándo terminó.

TAREA 4 — Textos de motivo (compartidos en la página)
Mapa reason → español de Chile, mismo texto en lista y detalle:
  no_balance → «Se agotó la bolsa de mensajes — compra un paquete y reanuda»
  tenant_cap → «Tope diario de envíos alcanzado — se reanuda sola mañana»
  global_fuse → «Pausa de seguridad de la plataforma — se reanuda sola mañana»
  meta_rate_limit → «WhatsApp pidió bajar el ritmo — se reanuda sola en 1 h»
  channel_auth → «El canal de WhatsApp necesita reconexión (Canales)»
  channel_config → «Configuración del número incompleta (Canales)»
  too_many_failures → «Demasiados fallos seguidos — revisa los destinatarios»
  manual → «Pausada por {quien la pausó, si viene} / manualmente»

TAREA 5 — Pruebas
· pnpm typecheck + build de la web en verde.
· Smoke manual con el mock provider (WHATSAPP_PROVIDER=mock) y el simulador del
  repo: crear difusión a una etiqueta con 3 contactos de prueba, verla correr,
  pausar/reanudar, cancelar; estados vacíos (sin plantillas, sin segmentos).
· Cuidado e2e robustez del CI: las páginas deben renderizar sin reventar con
  respuestas vacías o null.

ENTREGA
· Archivos creados/tocados, capturas o descripción del flujo completo, gaps de
  contrato si los hubo, typecheck + build en verde, y confirmación de que
  apps/web/src/app/admin quedó sin cambios.
```
