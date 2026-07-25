# Conversia (codename provisional)

Plataforma SaaS **multi-tenant** de atención conversacional por WhatsApp con múltiples agentes de IA, constructor de workflows, gestión de leads y agendamiento mediante proveedores externos (Cláriva, Dentalink, Google Calendar, mock).

> Digital Dent es el **primer tenant piloto** — se carga por seeds/configuración, sin lógica especial en el código. Cláriva es una plataforma **externa e independiente** que se integra como proveedor de agenda.

## Estructura

```
apps/
  api/            API NestJS (auth, tenancy, conversaciones, webhooks)
  worker/         Procesador BullMQ (mensajes entrantes, orquestador IA, timers de workflows)
  web/            Panel Next.js (login, bandeja de conversaciones)
  mock-clariva/   Servidor mock del contrato de agenda de Cláriva
packages/
  types/          Contratos compartidos (agenda, IA, canales, tools, workflows)
  config/         Carga y validación de variables de entorno (zod)
  database/       Prisma schema, RLS, seeds (Digital Dent como datos)
  agents/         Proveedores IA (Anthropic/Mock), registro de tools, orquestador
  workflows/      Motor de ejecución de workflows v0
  scheduling/     Proveedores de agenda (Mock, Cláriva)
docs/             Arquitectura, decisiones, contratos, roadmap
scripts/          Utilidades (simulador de mensajes entrantes)
```

## Requisitos

- Node >= 20, pnpm >= 9 (`npm i -g pnpm`)
- Docker Desktop (Postgres + Redis locales) — o instancias remotas (Railway)

## Puesta en marcha

```bash
pnpm install
copy .env.example .env          # completar valores
docker compose up -d            # postgres (pgvector) + redis
pnpm db:generate                # genera cliente Prisma
pnpm db:migrate                 # crea el esquema
pnpm db:setup                   # extensión pgvector + roles + RLS + FKs dinámicas
pnpm db:seed                    # crea plataforma + tenant Digital Dent (datos, no código)
pnpm dev                        # api :4000, web :3000, worker, mock-clariva :4010
```

Simular un mensaje entrante de WhatsApp (sin credenciales de Meta):

```bash
node scripts/simulate-inbound.mjs --phone 56912345678 --text "Hola, quiero una hora para implantes"
```

## Documentación

Ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/MULTITENANCY.md](docs/MULTITENANCY.md), [docs/DECISIONS.md](docs/DECISIONS.md), [docs/ROADMAP.md](docs/ROADMAP.md) y el resto de `docs/`.

## Principios no negociables

1. **Multi-tenant desde el día 1**: todo registro relevante lleva `organization_id`; RLS en Postgres + filtros en aplicación + colas con tenant obligatorio.
2. **Nada rígido en código**: precios, prompts, agentes, workflows, estados y reglas viven en la base de datos por tenant.
3. **La IA nunca inventa**: precios/disponibilidad/profesionales salen de datos estructurados o herramientas validadas server-side.
4. **Trazabilidad total**: cada mensaje registra agente, versión, tools ejecutadas, tokens y costo.
