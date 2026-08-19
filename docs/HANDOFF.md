# Handoff (se SOBRESCRIBE en cada cierre de tarea)

**Última tarea (2026-08-19): fix del import de contactos (timeout de transacción).**

- Causa doble en `apps/worker/src/contact-import.ts`: lote de 200 filas en una
  transacción interactiva con default 5 s + lecturas invariantes (leadStatus,
  customFieldDefinition) dentro del bucle por fila (~11 consultas/fila).
- Fix: lecturas invariantes 1 vez por job; `withTenant(orgId, fn, client?, opts?)`
  acepta opciones de `$transaction` (default global intacto); CHUNK 50 con
  `{ timeout: 30_000, maxWait: 10_000 }`; lote fallido → rango en `errors[]` y
  el job continúa. Regresión: `contact-import.test.ts` (320 filas + lote fallido).
- Semántica intacta: dedupe por teléfono, updateExisting rellena solo vacíos,
  import NO dispara `tag_added`, RLS vía withTenant en toda escritura.
- **Pendiente de verificación en prod**: reintentar el CSV de 3.763 filas de
  Digital-Dent y comprobar que `created + updated + skipped + errores` cierra
  contra el total (lo hace el usuario tras el deploy).

**Contexto de la rama paralela (worktree `conversia-crm`):** omnicanal IG/Messenger
B1–B4 mergeados (PRs #158/#159/#161) — activación del tenant TuBot pendiente de
token con scopes de mensajería + reconectar página (ver docs/OMNICHANNEL.md y
memoria del agente).
