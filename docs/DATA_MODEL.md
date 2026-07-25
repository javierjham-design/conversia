# Modelo de datos

Fuente de verdad: [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma) (~50 modelos, tablas snake_case vía `@@map`). Endurecimiento: [`packages/database/sql/setup.sql`](../packages/database/sql/setup.sql) (RLS + FKs dinámicas + pgvector + rol app).

## Convenciones

- IDs `cuid()` texto; timestamps `created_at/updated_at`; soft delete `deleted_at` en entidades núcleo (organizations, clinics, agents, workflows, contacts).
- `organization_id` obligatorio en datos de tenant (`clinic_id` opcional); índices compuestos por tenant; unicidades `(organization_id, X)`.
- Config flexible en columnas `Json` (`settings`, `config`, `meta`, `payload`) — lo que el panel edita sin migraciones.
- Relaciones Prisma solo intra-dominio (Conversation↔Message, Workflow↔Version↔Run…). Las FKs a `organizations` las agrega `setup.sql` dinámicamente (menos ruido en el schema, cobertura automática).

## Dominios

| Dominio | Tablas |
|---|---|
| Plataforma | platform_admins, plans, users |
| Tenant | organizations, organization_domains, subscriptions, usage_events, clinics, roles, organization_users, clinic_users, teams, team_members |
| Contactos/Leads | contacts, contact_identities, custom_field_definitions, custom_field_values, lead_statuses, leads, lead_events, campaigns, tags, tag_assignments |
| Canales | channel_connections, whatsapp_accounts, whatsapp_phone_numbers, whatsapp_templates |
| Conversaciones | conversations, messages, message_attachments |
| Agentes | agent_templates, agents, agent_versions, agent_assignments, agent_handoffs, human_handoffs, approval_requests |
| Conocimiento | knowledge_bases, knowledge_documents, knowledge_chunks (vector 1536) |
| Agenda | professionals, services, clinic_services, professional_services, appointments, scheduling_connections |
| Workflows | workflows, workflow_versions, workflow_runs, workflow_run_steps, scheduled_jobs |
| Integraciones | integration_connections, integration_credentials, webhook_endpoints, webhook_deliveries |
| Operación | audit_logs, ai_requests, system_alerts, files, notifications |

## Fusiones respecto a la lista del brief (sección 40)

| Brief | Implementación | Motivo |
|---|---|---|
| permissions + role_permissions | `roles.permissions Json` (strings `modulo:accion`) | Simplicidad; `hasPermission()` en types |
| plan_features / subscription_items | `plans.features` / `subscriptions.items` Json | Facturación desactivada en MVP |
| sources | `campaigns.source` | Un solo origen por campaña |
| contact_tags | `tag_assignments` polimórfico (contact/conversation/lead) | Etiquetas en 3 entidades sin 3 tablas |
| internal_notes | `messages` con `visibility=INTERNAL`, `type=NOTE` | Mismo timeline |
| conversation_channels/participants | `conversations.channel_connection_id` + assigned_user/team | Suficiente v0; participants si se necesita multi-agente humano |
| workflow_nodes/edges/variables | `workflow_versions.definition Json` validado con zod | ADR-4 |
| agent_tools | `agent_versions.tools Json` (lista de nombres) | El registro de tools es código versionado |
| ai_usage | agregación de `ai_requests` + `usage_events` | Sin duplicar datos |
| billing_customers/invoices/payment_methods/credits/overage_rules | pendientes (BILLING.md) | Fase 7; el consumo ya se registra |
| scheduled_jobs | igual + rol adicional de timer de workflows | Fuente de verdad de esperas |

## Retención y eliminación (diseño)

- Exportación/eliminación por tenant = recorrer tablas por `organization_id` (FKs ON DELETE CASCADE facilitan el hard delete completo).
- Retención configurable por plan (campo `plans.limits.retentionDays`) — job de purga pendiente (fase 7).
