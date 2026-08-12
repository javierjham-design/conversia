# Flujos de trabajo — catálogo y comportamiento

Catálogo vigente de disparadores y pasos del módulo de Flujos, con su
comportamiento real y la política de errores actual. La prueba funcional de cada
uno está en `docs/FLOWS_TEST_MATRIX.md`. Motor puro: `packages/workflows`.

## Arquitectura (resumen)
- **Motor puro** (`@conversia/workflows`): recorre el grafo `{trigger, nodes, edges}`
  y llama efectos por inyección (`EngineDeps`). Sin infraestructura → testeable.
- **Estado en Postgres**: `workflow_runs` (una corrida), `workflow_run_steps`
  (cada paso ejecutado con salida/estado), `scheduled_jobs` (esperas largas).
- **Ejecutores reales** en el worker (`workflow-runtime.ts`): implementan
  `EngineDeps` sobre la plataforma (enviar, etiquetar, agente, HTTP con guard
  SSRF, CAPI/GA4/Sheets/correo, timers).
- **Disparo**: `dispatchEvent` casa el evento contra los flujos publicados
  (`matchesTrigger`) con idempotencia por `(workflow, conversación/contacto, tipo)`.

## Disparadores
Nueva conversación · Mensaje recibido (canal · palabra contiene/exacto ·
cualquiera/todas · primer mensaje) · Conversación cerrada · Anuncios
Click-to-Chat (Meta; por anuncio o campaña) · Etapa del ciclo de vida
(origen→destino) · Etiqueta añadida · Cita creada/confirmada/reprogramada/
cancelada/no-show (filtros servicio/profesional/sede) · Recordatorio de cita
(X h antes, respeta horario) · Disparo manual. **Próximamente** (no
seleccionables): Llamada perdida, Anuncios TikTok.

**Ayudas del panel (Bloque 3):** vista previa en lenguaje natural («Se activará
cuando…») derivada de la config; **probar el disparador** de mensaje (escribes un
texto y dice si dispararía, refleja `matchesKeywords`); **detección de conflictos**
en vivo y al publicar: si otro flujo activo reacciona al mismo evento, se avisa con
la lista (no bloquea). La lógica de solape es `triggersMayOverlap` en
`@conversia/workflows` (conservadora: ante la duda, avisa) — ver
`apps/api …/workflows.controller.ts` (endpoint `:id/trigger-conflicts` + retorno de
`publish`).

## Pasos por categoría
- **Mensajes**: Enviar mensaje (variables `{{...}}`), Enviar plantilla WhatsApp (HSM).
- **Contacto**: Cambiar etapa, Agregar/Quitar etiqueta, Actualizar datos.
- **Conversación**: Abrir conversación, Comentario interno, Asignar a usuario/
  equipo, Escalar a humano, Cerrar conversación.
- **Control de flujo**: Esperar, **¿El contacto respondió?** (Sí/No),
  ¿Sigue sin responder? (instantáneo), Fecha y hora (horario), Saltar a otro
  paso, Disparar otro flujo, Terminar.
- **IA**: Ejecutar agente, Cambiar agente, Agente con objetivo (cumplido/no).
- **Integraciones**: Petición HTTP, Correo interno, Google Sheets.
- **Marketing**: Evento CAPI (Meta), Evento GA4. Evento TikTok (Próximamente).

Reservados en el modelo pero **no ofrecidos** (no aparecen en el menú):
`send_media`, `classify_intent`, `extract_data`, `summarize`,
`check_availability`, `create_appointment`, `confirm_appointment`,
`cancel_appointment`, `branch`, `cancel_workflows`, `send_webhook`,
`notify_team`, `pause_ai`, `resume_ai` (los dos últimos sí los ejecuta el motor).

## Política de errores (comportamiento ACTUAL)
- **Petición HTTP**: URL insegura/inválida (SSRF) → el paso **falla**. Errores de
  red/HTTP (timeout, 4xx, 5xx, redirección) → **no lanzan**; se exponen como
  variables `__http_ok`, `__http_status`, `__http_error` para poder ramificar.
- **Enviar plantilla**: si el gate de mensajería bloquea (sin saldo, switch
  apagado, plan, tope, fusible) el mensaje queda `FAILED` con motivo claro + nota
  de sistema; **no** reintenta en bucle. El flujo continúa.
- **Enviar mensaje / agente**: error de canal (token/nombre) → mensaje `FAILED`
  con texto claro y se marca el canal; el flujo continúa.
- **CAPI/GA4/Sheets/correo**: se **encolan** con reintentos (BullMQ backoff); un
  fallo transitorio no rompe el flujo.
- **Espera**: se materializa como `scheduled_job`; el timer la reanuda. `wait`
  con «cancela si responde» cancela el run; `wait_reply` **no** lo cancela (una
  respuesta lo continúa por la rama «Sí»).
- **Anti-bucle**: máx. 50 nodos por ejecución, máx. 25 saltos (`goto`).

### Brechas conocidas (→ Bloque 5)
- No hay aún **política configurable por paso** (reintentar N/continuar/detener)
  ni **rama de error** explícita en el editor para HTTP/plantilla/agenda.
- No hay **timeout global** de ejecución configurable ni **notificación** al
  tenant por fallos repetidos de un flujo publicado.
Estas quedan documentadas y marcadas; ver `docs/FLOWS_TEST_MATRIX.md` §7.

## Validación al publicar
`validateWorkflowDefinition` bloquea publicar con: nodos sin conectar, campos
requeridos vacíos (mensaje, etiqueta, agente, etapa, flujo…), referencias rotas
(etiqueta/agente/etapa/flujo inexistentes), esperas en 0, y requisitos de
integración (plantilla aprobada + capacidad de plantillas del tenant, dataset
CAPI, GA4/Google conectados, paso HTTP premium por plan).
