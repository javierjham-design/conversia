# Changelog

## 2026-08-20 — feat: push por mensaje nuevo en conversaciones atendidas por humanos

Faltaba el aviso «por mensaje» cuando la IA NO va a responder (aiEnabled=false: escalada,
«atender yo», o importada con IA apagada) — el humano a cargo no se enteraba de mensajes nuevos
salvo por la escalera de «sin responder». Ahora:
- Evento nuevo de catálogo `message.received_human` («Nuevo mensaje de {contactName}»), canales
  in_app + web_push (default) + email (opcional), link directo a la conversación. Aparece solo
  en la matriz de preferencias; cada usuario puede apagarlo.
- `notifyHumanAttendedMessage` (worker) enganchado en AMBAS ingestas (WhatsApp `inbound.ts` y
  Messenger/IG `messaging-inbound.ts`): si la conversación tiene la IA apagada, avisa al usuario/
  equipo asignado; sin asignación, a admins/owner del tenant (fallback explícito).
- Reutiliza toda la infraestructura existente: presencia (no hay push de la conversación que ya
  estás mirando), horario silencioso, dedup por tag de conversación y limpieza de dispositivos
  caducados. VAPID verificado presente en worker+api de Railway.

## 2026-08-19 — fix: la derivación entre agentes de IA ahora funciona (y el probador no miente)

Bug real (Digital-Dent, WhatsApp con pacientes): Recepción debía derivar las consultas de
implantes a RESP IMPLANTES y no lo hacía — le decía al paciente «te derivé» y nadie contestaba;
`activeAgentId` seguía en Recepción. Causa: el modelo llamaba `assignConversation` (solo resuelve
equipos/personas, nunca agentes) o `transferToAgent` con el NOMBRE visible mientras la resolución
era solo por slug; y un `{error}` devuelto por la tool no se marcaba como error, así el modelo lo tapaba.
Fix:
- `normalizeAgentKey` + `resolveAgentByNameOrSlug` en `@conversia/database`: resuelve por nombre O
  slug, insensible a mayúsculas/acentos/guiones/@ («@RESP IMPLANTES» == «resp-implantes»).
- `agent-turn.ts`: la transferencia acepta destino de `transferToAgent` O de `assignConversation`
  (cuando el destino resultó ser otro agente); resuelve por nombre/slug, MANTIENE `aiEnabled` y el
  agente destino responde en el MISMO turno (`depth+1`, un salto por turno, sin loops); registra
  `agentHandoff`. Deja nota-incidente si el destino no existe.
- `assignConversation` (tool-services): equipo/persona → asigna y apaga la IA; agente → marcador de
  transferencia sin apagar la IA; nada → LANZA (isError, el modelo no puede tapar el fallo) y deja una
  NOTA INTERNA de incidente visible en la Bandeja.
- Probador = producción: el sandbox resuelve/valida el destino igual que el runtime y SIMULA la
  respuesta del agente destino; si no funcionaría en prod, tampoco aparece la transferencia.
- UI: la tarjeta «Asignar / derivar» se separó en «Derivar a otro agente de IA» (transferToAgent) y
  «Asignar / escalar a persona o equipo» (assignConversation + transferToHuman).
- Test: `apps/worker/src/agent-transfer.test.ts` cubre el caso que falló (derivar a un target que es
  otro agente por nombre/slug/mención/acentos; null si es equipo/persona).

## 2026-08-19 — feat: importador de historial de mensajes (migración Respond.io)

Nuevo circuito para traer los 32.660 mensajes históricos de Digital-Dent (y de
cualquier migración futura): botón "Historial" en Contactos sube el CSV de
Data export → Messages de Respond.io; el cliente lo envía en tandas de 5.000
al endpoint `POST /contacts/import-messages` y el worker (cola
`message-imports`) escribe por lotes de 500 con timeout explícito. Cruce por el
campo `id_respond_io`; conversación por (contacto, canal Respond) CLOSED y con
aiEnabled=false; `Message ID → externalId` con `skipDuplicates` = idempotente
(correr dos veces no duplica); hora convertida de America/Santiago a UTC con
DST correcto; OUTBOUND entra como SENT. REGLA DE ORO (comentada en el código):
escribe en la base y NADA más — sin agentes, sin flujos, sin webhooks, sin
consumo, sin envíos. Resultado: importados / duplicados / sin contacto /
conversaciones creadas + errores por lote. 5 tests del mapper y la TZ.
Pendiente decidido aparte: adjuntos de cdn.chatapi.net (recomendación:
descargarlos pronto en un job de respaldo; el payload conserva las URLs).

## 2026-08-19 — fix: import de contactos ya no muere por timeout de transacción

Bug real (Digital-Dent, 3.763 filas de Respond.io): cada lote de 200 filas corría
en UNA transacción interactiva con el default de 5 s de Prisma, y el bucle por
fila releía etapas y definiciones de campos (~11 consultas/fila ≈ 10 filas/s) →
con >50 filas la transacción expiraba y el import fallaba entero sin escribir.
Fix en `apps/worker/src/contact-import.ts`: lecturas invariantes UNA vez por job
(withTenant corto), lotes de 50 con `{ timeout: 30 s, maxWait: 10 s }` (nuevo
parámetro opcional de `withTenant` que pasa opciones a `$transaction` SIN cambiar
el default global), y un lote fallido registra su rango en `errors` y el import
continúa (created/updated/skipped/errors reales). Test de regresión con 320 filas
+ lote fallido aislado (2 tests). Sin cambios de semántica: dedupe por teléfono,
updateExisting solo rellena vacíos, y el import sigue SIN disparar `tag_added`.

## [0.1.0] — 2026-07-25

Fundación del proyecto: monorepo, esquema multi-tenant con RLS, auth+tenancy, pipeline WhatsApp E2E (mock/real), capa de agentes IA con tools y orquestador, motor de workflows v0 con timers persistentes, proveedores de agenda (mock + cliente Cláriva + servidor mock del contrato), panel web v0 (login + bandeja con control humano), seeds de 2 tenants (Digital Dent + demo), documentación completa y CI. Detalle en docs/PROGRESS.md.
