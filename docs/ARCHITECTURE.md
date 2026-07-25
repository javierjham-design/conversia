# Arquitectura

## Visión

SaaS multi-tenant de atención conversacional: WhatsApp → agentes de IA configurables → workflows → agendamiento vía proveedores externos. Un solo despliegue sirve a N organizaciones con aislamiento estricto (ver [MULTITENANCY.md](MULTITENANCY.md)).

## Diagrama general

```mermaid
flowchart LR
  subgraph Canales
    WA[WhatsApp Cloud API]
    SIM[Simulador scripts/simulate-inbound.mjs]
  end

  subgraph API["apps/api (NestJS)"]
    WH["/webhooks/whatsapp<br/>verificación firma"]
    AUTH[Auth + Tenancy JWT]
    INBOX[Conversaciones + SSE]
    ORGS[Organizaciones/Agentes/Workflows]
  end

  subgraph Worker["apps/worker (BullMQ)"]
    INB[Procesador inbound]
    ORQ[Orquestador multiagente]
    WFR[Runtime de workflows]
    SCH[Scheduler de timers]
    OUT[Procesador outbound]
  end

  subgraph Packages
    AG["@conversia/agents<br/>AIProvider + tools"]
    WF["@conversia/workflows<br/>motor puro"]
    SP["@conversia/scheduling<br/>SchedulingProvider"]
  end

  WA --> WH
  SIM --> WH
  WH --> Q[(Redis / BullMQ)]
  Q --> INB
  INB --> ORQ
  INB --> WFR
  SCH --> WFR
  ORQ --> AG
  WFR --> WF
  AG --> LLM[Anthropic API / Mock]
  AG --> SP
  SP --> CLARIVA[Cláriva API]
  SP --> MOCKC[apps/mock-clariva]
  SP -.futuro.-> DENTALINK[Dentalink]
  SP -.futuro.-> GCAL[Google Calendar]
  API --> DB[(PostgreSQL + RLS + pgvector)]
  Worker --> DB
  WEB[apps/web Next.js] --> API
```

## Stack

| Capa | Elección | Motivo |
|---|---|---|
| Frontend | Next.js 15 + React 19 + Tailwind 4 | Estándar, SSR/CSR flexible, el equipo ya usa Next (Cláriva) |
| Backend API | NestJS 11 + TypeScript | Módulos, DI, middleware; validación con zod |
| Worker | Node + BullMQ (sin Nest) | Procesos de cola simples, arranque rápido |
| BD | PostgreSQL 16 + pgvector | RLS nativo para tenancy, vectores para RAG |
| ORM | Prisma 6 | Productividad + migraciones; RLS vía `withTenant` |
| Colas | BullMQ + Redis | Suficiente para MVP (ver ADR-3 en DECISIONS.md) |
| Timers | Tabla `scheduled_jobs` en Postgres | Esperas de días sobreviven reinicios de Redis |
| IA | Capa `AIProvider` (Anthropic primero) | Multi-proveedor desde el día 1; Mock para dev |
| Monorepo | pnpm workspaces + Turborepo | Builds incrementales, paquetes compartidos |
| Hosting MVP | Railway (Postgres+Redis+3 servicios) | Ya usado por el equipo; migración documentada en DEPLOYMENT.md |

## Flujo de un mensaje entrante

```mermaid
sequenceDiagram
  participant M as Meta/Simulador
  participant API as api /webhooks/whatsapp
  participant Q as Redis (inbound)
  participant W as worker
  participant DB as Postgres (RLS)
  participant IA as AIProvider
  participant CH as ChannelProvider

  M->>API: POST webhook (raw)
  API->>API: verificar firma HMAC (si meta)
  API->>Q: encolar job (ACK 200 inmediato)
  Q->>W: processInbound
  W->>DB: resolver tenant por phone_number_id (lookup global de ruteo)
  W->>DB: withTenant: upsert contacto+identidad, conversación, mensaje (idempotente por wamid)
  W->>DB: cancelar timers cancelOn=contact_reply
  W->>W: dispatchEvent(conversation_started / message_received) → workflows
  W->>DB: cargar agente activo + versión publicada + historial ventaneado
  W->>IA: orchestrate(system renderizado, historial, tools)
  IA-->>W: texto y/o tool_use (loop acotado, tools validadas con zod)
  W->>DB: persistir mensaje saliente + ai_request + usage_event
  W->>CH: send() → Meta o Mock
  W->>DB: actualizar estado SENT/FAILED + wamid
  Note over W: transferToAgent → cambia agente activo + agent_handoff<br/>transferToHuman → aiEnabled=false + human_handoff
```

## Flujo de una ejecución de workflow

```mermaid
sequenceDiagram
  participant EV as Evento (mensaje, cita, timer…)
  participant WR as workflow-runtime
  participant EN as Motor (@conversia/workflows)
  participant DB as Postgres
  participant SJ as scheduled_jobs

  EV->>WR: dispatchEvent(PlatformEvent)
  WR->>DB: workflows activos + versión PUBLICADA
  WR->>EN: matchesTrigger(def, evento)
  WR->>DB: crear workflow_run (idempotencyKey único)
  EN->>EN: executeFrom(nodo inicial)
  loop por nodo
    EN->>WR: efecto (send_text / run_agent / condition / …)
    WR->>DB: persistStep (trazabilidad por nodo)
  end
  alt nodo wait
    EN->>SJ: scheduleTimer(dueAt, cancelOn)
    EN-->>WR: status WAITING
    Note over SJ: scheduler sondea cada 15s.<br/>Respuesta del contacto → CANCELLED
    SJ->>WR: resumeRun(runId, nodeId)
    WR->>EN: resumeAfterWait → continúa
  else fin / stop
    EN-->>WR: COMPLETED / FAILED → cerrar run
  end
```

## Decisiones estructurales

Registradas como ADRs en [DECISIONS.md](DECISIONS.md). Las más importantes:

1. **RLS con esquema compartido** (no BD-por-tenant): miles de tenants pequeños, workflows/colas compartidos. Escape hatch: tenants premium a BD dedicada reutilizando el mismo schema Prisma.
2. **BullMQ + timers en Postgres** en lugar de Temporal para el MVP.
3. **Grafo de workflow serializado en JSON versionado** (no tablas nodo/arista) — es el formato natural del editor visual.
4. **Worker sin NestJS**: menos capas donde no aportan.
5. **SSE con sondeo** para tiempo real v0; upgrade a Redis pub/sub + WebSockets planificado.

## Estructura del monorepo

Ver árbol en [../README.md](../README.md). Diferencias justificadas frente a la propuesta original del brief: `webhook-gateway` está integrado en `apps/api` (separarlo solo cuando el volumen lo exija); `packages/{auth,security,observability,knowledge,ui,testing}` se extraerán cuando su contenido crezca — hoy viven dentro de api/worker/agents para evitar paquetes vacíos.
