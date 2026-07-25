# Workflows y automatizaciones

## Formato

`workflow_versions.definition` (JSON validado por `workflowDefinitionSchema` en `@conversia/types`):

```json
{
  "trigger": { "type": "conversation_started", "config": {} },
  "variables": {},
  "nodes": [
    { "id": "n1", "type": "run_agent", "config": { "agentSlug": "recepcionista" } },
    { "id": "n2", "type": "wait", "config": { "minutes": 5, "cancelOn": "contact_reply" } },
    { "id": "n3", "type": "condition", "config": { "kind": "no_reply" } },
    { "id": "n4", "type": "send_text", "config": { "text": "¿Sigues ahí, {{contact.firstName}}?" } }
  ],
  "edges": [
    { "from": "n1", "to": "n2" }, { "from": "n2", "to": "n3" },
    { "from": "n3", "to": "n4", "when": "true" }
  ]
}
```

- Triggers soportados (types): lista completa en `TRIGGER_TYPES` (mensaje, conversación iniciada, keyword, cambios de lead, citas, timers, webhook, manual…). El runtime v0 emite `conversation_started` y `message_received`; el resto de emisores se agregan al implementar cada dominio.
- Nodos (types): catálogo en `NODE_TYPES`; implementados en v0: send_text, run_agent, update_lead_status, add_tag, transfer_human, pause_ai, resume_ai, close_conversation, wait, condition, stop. Los demás están tipados y devuelven no-op hasta implementarse.
- `position {x,y}` reservado para el editor visual (React Flow) — el backend ya acepta/preserva el campo.

## Motor (packages/workflows — puro, testeado)

- `matchesTrigger` → `executeFrom(nodo inicial)` → por nodo: efecto inyectado (`EngineDeps`) + `persistStep`.
- `wait` → `scheduled_jobs` (dueAt, `cancelOn`) + run en WAITING. El scheduler (worker) sondea cada 15s con claim optimista y llama `resumeAfterWait`.
- **Cancelación**: cuando el contacto responde, `cancelTimersOnReply` cancela timers `cancelOn=contact_reply` y sus runs (v0 cancela el run completo; rama "respondió" explícita es mejora pendiente).
- **Idempotencia**: `workflow_runs.idempotency_key = workflowId:conversación:tipoEvento` (unique por tenant) — un evento duplicado no crea dos runs. Steps registrados por nodo con estado/output/error.
- **Versionado**: el run guarda `version_id`; publicar una versión nueva no afecta runs en curso.
- Límites: 50 nodos por ejecución (anti-loop); errores marcan run FAILED con el nodo culpable.

## Ejemplos cargados por seed (Digital Dent)

1. **Lead nuevo por WhatsApp**: estado nuevo → agente recepcionista → espera 5 min (cancela si responde) → seguimiento → espera 12 h → cold_lead.
2. **Confirmación de cita**: recordatorio con variables → espera respuesta → agente de agendamiento. (El trigger `appointment_upcoming` requiere el job programado por cita — ticket #5 del roadmap.)

## Pendiente

Editor visual · nodos de integración (call_api con SSRF-guard, send_template, webhooks salientes) · subflujos y branch múltiple · variables tipadas con expresiones seguras (sin eval) · métricas por nodo (conversión, abandono) · política de reintentos por nodo configurable.
