# Handoff (se SOBRESCRIBE en cada cierre de tarea)

**Última tarea (2026-08-19): importador de historial de mensajes de Respond.io.**

- Flujo: Contactos → botón **"Historial"** → CSV de Data export → Messages →
  tandas de 5.000 a `POST /contacts/import-messages` → job `message-imports`
  (worker `respond-import.ts`) → lotes de 500 con `{timeout:30s, maxWait:10s}`.
- Cruce por campo personalizado `id_respond_io`; sin match → `skippedNoContact`
  (los 186 contactos de IG/Msgr/TikTok sin teléfono se omiten y reportan —
  propuesta pendiente: crearles ficha sin teléfono, hoy el modelo YA lo permite
  post-omnicanal; decidir con el usuario antes).
- Conversación por (contacto, canal Respond) con status CLOSED + aiEnabled
  false + meta.importedFrom; lastMessageAt/preview del último mensaje real.
- Idempotencia: externalId=Message ID + `createMany skipDuplicates` (correr 2
  veces no duplica — verificarlo en la prueba real). Hora America/Santiago→UTC
  con DST (`santiagoToUtc`, testeada invierno/verano).
- REGLA DE ORO comentada en respond-import.ts: escribe y NADA más (sin
  agent-turn, dispatchEvent, webhooks, recordUsage ni envíos). No "arreglar".
- **Adjuntos (318 con URL de cdn.chatapi.net)**: recomendación dada al usuario
  = descargarlos PRONTO a nuestro storage en un job aparte (las URLs morirán
  al cerrar la cuenta); el payload ya conserva las URLs para ese job.
- **Verificación pendiente (usuario, post-deploy)**: importar el archivo
  completo, abrir en Bandeja un contacto con conversación larga (hilo completo
  en orden), correr el import 2.ª vez y confirmar 0 nuevos.

**Contexto de la línea paralela (worktree conversia-crm):** Meta CRM operativo
(OAuth 1-clic + diagnóstico de mensajería por página); omnicanal IG/Messenger
B1-B4 en prod — pendiente del usuario: diagnóstico de la página TuBot para
destrabar los DMs (ver memoria del agente y docs/OMNICHANNEL.md).
