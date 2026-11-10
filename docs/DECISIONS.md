# Registro de decisiones (ADR)

Formato corto: contexto → decisión → consecuencias. Fecha 2026-07-25 salvo indicación.

## ADR-1 — Multi-tenant por RLS con esquema compartido
**Contexto**: aislamiento no negociable; muchos tenants pequeños esperados.
**Decisión**: una BD, políticas RLS dinámicas sobre toda tabla con `organization_id`, GUC `app.org_id` por transacción (`withTenant`), rol de app sin bypass.
**Consecuencias**: operación simple, aislamiento verificable en la BD; enterprise puede migrar a BD dedicada (mismo schema). Distinto de la decisión BD-por-clínica de Cláriva: productos y perfiles de carga diferentes.

## ADR-2 — Prisma 6 como ORM
**Contexto**: velocidad de desarrollo + migraciones; RLS requiere control transaccional.
**Decisión**: Prisma con `@@map` snake_case; RLS/FKs dinámicas en `sql/setup.sql` (re-ejecutable tras cada migración); `withTenant` como único punto de acceso.
**Consecuencias**: el SQL de endurecimiento vive fuera de las migraciones Prisma (paso `db:setup` documentado y presente en CI/deploy).

## ADR-3 — BullMQ + timers en Postgres (no Temporal en MVP)
**Contexto**: workflows con esperas de horas/días, reintentos, cancelación.
**Decisión**: BullMQ para trabajo inmediato; esperas persistidas en `scheduled_jobs` (fuente de verdad en Postgres, sondeo cada 15s, claim optimista). Estado de runs en `workflow_runs/steps`.
**Consecuencias**: cero infraestructura extra; sobrevive reinicios de Redis. Si la complejidad crece (sagas, señales, child workflows), migrar el motor a Temporal manteniendo la definición JSON — el motor es puro y está aislado en `@conversia/workflows`.

## ADR-4 — Definición de workflow como JSON versionado
**Contexto**: el brief pedía tablas `workflow_nodes/edges/variables`.
**Decisión**: el grafo completo (trigger, nodos, aristas, variables) se serializa en `workflow_versions.definition` (validado con zod). Los runs referencian `nodeId` strings.
**Consecuencias**: publicar = insertar fila inmutable (versionado trivial, el run sigue su versión); el editor visual (React Flow) lee/escribe su formato natural. Se pierde consulta relacional por nodo — irrelevante para los casos de uso.

## ADR-5 — Capa AIProvider multi-proveedor; Anthropic primero
**Decisión**: interfaz `AIProvider` (chat con tools, embed) en `@conversia/types`; `AnthropicProvider` real, `MockAIProvider` para dev/test. Modelos por defecto: `claude-opus-4-8` (conversación), `claude-haiku-4-5` (clasificación). Sin parámetros de sampling (removidos en Opus 4.7+). Precios en `packages/agents/src/pricing.ts` para costo por request.
**Consecuencias**: cambiar de modelo/proveedor es configuración del agente, no código. Embeddings requieren proveedor aparte (OpenAI u otro) — mock incluido.

## ADR-6 — Webhook de WhatsApp dentro de apps/api
**Contexto**: el brief proponía `apps/webhook-gateway` separado.
**Decisión**: endpoint en la API (valida firma y encola en <10ms); separar solo cuando el volumen/aislamiento de fallos lo justifique.

## ADR-7 — Worker sin NestJS
**Decisión**: procesadores BullMQ en TS plano. Nest aporta DI/HTTP que el worker no necesita.

## ADR-8 — Notas internas fusionadas en messages
**Decisión**: `messages.visibility=INTERNAL` + `type=NOTE` en lugar de tabla `internal_notes`. Mismo timeline, menos joins.

## ADR-9 — Auth propia con JWT (jsonwebtoken + bcryptjs)
**Decisión**: sin passport; middleware que corre el request dentro de AsyncLocalStorage con el contexto de tenant. bcryptjs (JS puro) evita problemas de compilación nativa en Windows.
**Consecuencias**: revisar antes de producción: refresh tokens, revocación, 2FA (ROADMAP fase 7).

## ADR-10 — Codename "Conversia"
**Decisión**: nombre provisional del repo/paquetes (`@conversia/*`). El nombre comercial es configurable (white-label); renombrar el scope es un find/replace acotado.

## ADR-11 — Tiempo real v0 por sondeo (SSE/polling 3-4s)
**Decisión**: suficiente para validar producto; upgrade planificado a Redis pub/sub + WebSocket cuando haya usuarios concurrentes reales.

## ADR-12 — Digital Dent y Clínica Demo como seeds JSON
**Decisión**: `packages/database/seeds/*.json` cargados por `seed.ts` genérico. Cualquier cliente nuevo = un JSON más (o el onboarding UI de fase 7). Cero lógica condicionada por tenant en el código (verificable con grep).

## ADR-13 — Google Calendar en dos sentidos: sondeo con `syncToken`, no `events.watch`
**Contexto**: para traer a Conversia los cambios que el dueño hace en su Google Calendar (mover
o borrar una cita) Google ofrece dos caminos: `events.watch` (Google nos avisa por webhook) o
sondeo periódico con `events.list` + `syncToken`.

**Decisión**: **sondeo cada 5 minutos por calendario vinculado**, con `syncToken` guardado en
`integration_connections.config.syncTokens`; si Google responde 410 (token caducado) se reinicia
con una ventana de ayer a +60 días.

**Por qué no watch**: exige verificar el dominio del webhook ante Google y **renovar los canales
antes de que caduquen**. Un canal vencido deja de avisar **en silencio** — nadie se entera hasta
que un cliente reclama por una hora que ya no era. El sondeo se arregla solo si se cae, no
depende de que Google pueda alcanzarnos y su retraso máximo (5 min) es irrelevante para una
agenda. Costo: unas pocas llamadas por calendario cada 5 min, acotadas por `syncToken` (solo
trae lo que cambió).

**Decisión acompañante: borrar el evento en Google NO cancela la cita.** Queda marcada
("eliminada en Google, revisar") con dos acciones explícitas en el panel: *Cancelar cita* y
*Volver a crear en Google*. Un borrado por error —o un dedo torpe en el teléfono— no puede
cancelarle la hora a un cliente sin que una persona lo decida. Mover sí se aplica solo: es una
acción inequívoca y el riesgo de no aplicarla (recordatorio con la hora vieja) es peor.

**Anti-bucle**: al escribir en Google se guarda el `updated` que devuelve la API en
`appointment.meta.googleUpdated`; el sondeo descarta los eventos cuyo `updated` coincide. Sin
eso: escribimos → el sondeo lo ve como cambio → actualiza la cita → el espejo escribe otra vez.

**Alcance**: el sondeo está gateado a la marca **conversia**. Las cuentas de TuBot que hoy
espejan a Google siguen funcionando igual: traerles cambios desde Google sería un comportamiento
nuevo que nadie pidió.

## ADR-14 — El historial de Convi vive en TABLAS propias, no en un JSON

**Contexto**: la conversación con el copiloto vivía en el `useState` del widget. La navegación
del panel usa `<a href>` (carga completa), así que cambiar de sección la borraba, y el contexto
que recibía el modelo lo mandaba el NAVEGADOR en cada turno.

**Decisión**: `assistant_threads` + `assistant_messages`, con RLS por `organization_id`.

**Por qué no un JSON en una fila**, como `support_tickets.thread`: ahí el hilo es corto y se lee
entero. Acá hay que **paginar** (el dueño vuelve a conversaciones de hace semanas), **buscar** y
**resumir lo antiguo**. Un arreglo dentro de una fila obliga a traer el hilo completo en cada
turno y crece sin techo; a los cientos de mensajes, cada turno del copiloto arrastraría la
conversación entera solo para agregarle una línea.

**Consecuencia principal: el servidor es el dueño del contexto.** El historial que recibe el
modelo se lee de la base. El campo `history` del cuerpo se sigue aceptando por compatibilidad y
se **ignora** — antes, lo que Convi "recordaba" era lo que el cliente quisiera decirle.

**Un solo hilo abierto por usuario, garantizado por un índice único PARCIAL** (`WHERE status =
'open'`). Elegir el hilo es un busca-si-no-crea que dos pestañas del mismo dueño pueden ganar a
la vez; sin el índice quedarían dos hilos abiertos y la conversación se partiría en dos sin que
se entienda por qué.

**Conversaciones largas**: pasados los 40 mensajes se resume lo viejo en `thread.summary` con el
modelo barato del proveedor configurado, y el prompt pasa a ser `resumen + últimos 20`. El
resumen va en el prompt del SISTEMA, no como un mensaje más: es memoria, no una instrucción que
el dueño acabe de dar.

**Quién lo ve** (decisión del dueño): el propio usuario y los administradores de su
organización. Sin borrado automático por ahora.

**Costo aceptado**: dos tablas más bajo RLS y una llamada barata de resumen cada ~20 turnos de
una conversación larga.

## ADR-15 — `META_MESSAGING_REVIEW_APPROVED`: el producto se comporta bien en los DOS estados

**Contexto**: hasta que Meta apruebe la App Review de mensajería, Instagram y Messenger solo
entregan los DM de cuentas **con rol en la app**. Eso no se arregla con código y puede tardar
semanas.

**Decisión**: una bandera de plataforma (default `false`) que se expone en
`/public/meta-config` como `messagingReviewApproved`, y el producto entero se comporta bien en
los dos estados:

- **Se puede conectar igual.** El cliente conecta su Instagram y el canal queda operativo; lo
  que no llega todavía son los mensajes del público.
- **La tarjeta lo dice con calma**: «Meta está revisando nuestra app. Por ahora tu asistente
  solo recibe los mensajes de cuentas de prueba». Con un botón para que le avisen, no una
  fecha inventada.
- **La portada NO lo promete** mientras sea `false`. Decidir eso en el cliente no sirve: la
  portada se prerenderiza, así que el HTML que ve Google —y el revisor de anuncios de Meta—
  saldría prometiéndolo siempre. Se lee en el servidor.
- **Convi lo explica** igual: no es un error, no se puede apurar, y cuando Meta apruebe
  empieza a llegar todo sin que el cliente haga nada.

**Por qué no esperar a la aprobación para construirlo**: el trabajo de conexión, runtime y
cobro es el mismo, y dejarlo listo detrás de una bandera convierte el trámite de Meta en un
interruptor en vez de en un proyecto.

## ADR-16 — El OAuth de mensajería vuelve a la marca del cliente, con `return` firmado

**Contexto**: `GET integrations/meta-crm/oauth/authorize` servía a Lead Ads y su callback
redirigía SIEMPRE a `WEB_URL` (el panel de TuBot). Un cliente de Conversia que conectara
Instagram desde su pantalla de Canales terminaba en el panel de otra marca.

**Decisión**: el `state` del OAuth —que ya viajaba firmado con el `orgId`— ahora lleva también
el **propósito** (`leads` | `messaging`) y la **ruta de retorno**. El callback redirige a
`brandOf(org).webUrl + retorno` con `?meta=ok|permisos|error`.

**La parte delicada es el `retorno`**: es un dato que viene de la URL y termina en un
`Location:`. Sin cuidado, es un **redirect abierto** — el truco clásico de usar un dominio de
confianza para mandar a alguien a otro lado. Por eso: solo rutas relativas (nada de `//`, `:`,
`\` ni `..`), validadas con zod, **firmadas** dentro del `state`, y **vuelto a validar al
abrir**. Quitar esa validación pone 11 tests en rojo.

**Compatibilidad**: sin `retorno` todo sigue igual —TuBot vuelve a `/integrations/meta-crm`
con sus parámetros `oauth=` de siempre— y el formato viejo del `state` se sigue aceptando,
para que un viaje a Meta que empezó antes del cambio no quede colgado a mitad de camino.

**Los permisos exigidos dependen del propósito**: pedirle `leads_retrieval` a quien solo
quiere contestar sus DM lo dejaba afuera por un permiso que no necesita.
