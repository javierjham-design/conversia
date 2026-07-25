# Agentes de IA

## Modelo

- `agents`: identidad (slug, nombre, kind, sede opcional). Sin prompt.
- `agent_versions`: el contenido versionado — `system_prompt`, `config` (model, maxTokens, maxToolRounds, idioma…), `tools` (nombres habilitados). Estados DRAFT → PUBLISHED → ARCHIVED. El orquestador usa siempre la última PUBLISHED; cada mensaje registra `agent_version_id` (sabes qué versión respondió qué).
- `agent_templates`: plantillas globales (organization_id NULL) o del tenant; clonar = crear agent + version 1.
- `agent_assignments`: ámbitos (canal/sede/campaña/workflow) — el v0 usa `channel_connections.default_agent_id` y `conversations.active_agent_id`.

## Orquestación (v0 — packages/agents/src/orchestrator.ts)

1. El worker resuelve el agente: slug explícito (workflow) → agente activo de la conversación → default del canal.
2. Renderiza el prompt con variables `{{organization.name}}`, `{{clinic.city}}`, `{{contact.firstName}}`… (datos del tenant, jamás hardcodeados).
3. Historial ventaneado (últimos 20 mensajes públicos) — memoria corta. Memoria larga (resúmenes incrementales + extracción estructurada a `conversations.meta`) es fase 3 pendiente.
4. Loop de tools acotado (`maxToolRounds`): el modelo pide `tool_use` → registro valida con zod + permisos → ejecuta → devuelve `tool_result`.
5. Señales especiales capturadas por el orquestador:
   - `transferToAgent` → cambia `active_agent_id`, crea `agent_handoffs` (contexto conservado: mismo historial de conversación) y ejecuta un turno del nuevo agente (profundidad máx. 1).
   - `transferToHuman` → `ai_enabled=false` + `human_handoffs` + auditoría. La IA queda muda hasta "Devolver a IA" en el panel.
6. Trazabilidad: `ai_requests` (modelo, tokens, costo USD, latencia) + `usage_events` + tools ejecutadas en `messages.payload.toolEvents`.

## Tools disponibles (packages/agents/src/tools.ts)

getServices · getServicePrice · getProfessionals · getAvailability · createAppointment · updateLeadStatus · addTag · searchKnowledgeBase · transferToAgent · transferToHuman

Reglas: entrada zod, tenant fijado por contexto (el modelo no ve IDs de organización), errores devueltos como `is_error` para que el modelo corrija, salida truncada a 4KB. Nuevas tools = agregar al registro + habilitarlas en la versión del agente.

## Modelos y costos

Por defecto `claude-opus-4-8` (conversación) y `claude-haiku-4-5` (clasificación futura), configurables por versión de agente (`config.model`). Precios por MTok en `packages/agents/src/pricing.ts`. Sin temperature/top_p (removidos en Opus 4.7+; el tono se controla por prompt).

## Pendiente (fase 3)

Editor de agentes en panel (borrador→publicar, diff entre versiones) · simulador de conversaciones · pruebas A/B por versión · clasificación de intención/urgencia/sentimiento como paso previo barato (Haiku) que alimente el orquestador y los triggers · límites de costo por agente/tenant con corte automático.
