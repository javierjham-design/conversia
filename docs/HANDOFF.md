# Handoff (se SOBRESCRIBE en cada cierre de tarea)

**Última tarea (2026-08-19): fix de la derivación entre agentes de IA (Digital-Dent, prod).**

- Síntoma: Recepción (`recepcion-digital-dent`) no derivaba las consultas de implantes a
  RESP IMPLANTES (`resp-implantes`); le decía al paciente «te derivé» y nadie contestaba;
  `activeAgentId` seguía en Recepción y caía al agente por defecto del canal en cada mensaje.
- Causa: (1) el modelo llamaba `assignConversation` (solo equipos/personas) en vez de
  `transferToAgent`; (2) `transferToAgent` resolvía SOLO por slug y los prompts usan el
  nombre «@RESP IMPLANTES»; (3) un `{error}` devuelto por la tool NO se marcaba isError, así
  el modelo lo tapaba.
- Fix (archivos):
  - `@conversia/database`: `normalizeAgentKey` + `resolveAgentByNameOrSlug` (nombre O slug,
    sin acentos/mayúsculas/guiones/@).
  - `apps/worker/src/agent-turn.ts`: transferencia unificada (destino de `transferToAgent` o de
    `assignConversation`-agente), resuelve nombre/slug, mantiene `aiEnabled`, el destino responde
    en el MISMO turno (`depth+1`, sin loops); nota-incidente si el destino no existe.
  - `apps/worker/src/tool-services.ts`: `assignConversation` → equipo/persona (apaga IA) |
    agente (`handoffToAgentSlug`, no apaga IA) | nada (throw isError + nota-incidente en Bandeja).
  - `apps/api/src/agents/agents.controller.ts` + `agent-sandbox.ts`: el probador resuelve/valida
    el destino igual que el runtime y SIMULA la respuesta del agente destino (paridad con prod).
  - `apps/web/src/lib/agent-actions.ts`: dos tarjetas — «Derivar a otro agente de IA» y
    «Asignar / escalar a persona o equipo».
  - Test: `apps/worker/src/agent-transfer.test.ts`.
- **PENDIENTE de verificación E2E en prod** (lo hace el usuario, o con token del tenant
  Digital-Dent): mandar «necesito hora para implante» por WhatsApp y comprobar que la cabecera
  pasa a RESP IMPLANTES, que queda la fila en `agentHandoff`, y que responde el agente de
  implantes con su prompt (link de agendamiento de implantes, precio desde $599.900).
- Nota de entorno local: `vitest`/`vite` quedó roto en el temp (CLIENT_ENTRY) → los tests
  corren en CI (instalación limpia). Typecheck de worker/api/web: verde.

**Contexto de la rama paralela (worktree `conversia-crm`):** omnicanal IG/Messenger B1–B4
mergeados (PRs #158/#159/#161) — activación del tenant TuBot pendiente de token con scopes de
mensajería + reconectar página (ver docs/OMNICHANNEL.md y memoria del agente).
