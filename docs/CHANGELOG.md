# Changelog

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
