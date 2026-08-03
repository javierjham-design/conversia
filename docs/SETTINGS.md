# Centro de Configuración del tenant (/settings)

Mapa de QUÉ vive DÓNDE y qué módulo consume cada configuración. Regla: **una
sola fuente de verdad por configuración**; los módulos de origen conservan solo
accesos directos ("Gestionar ↗").

## Sidebar (grupos → páginas)

| Página | Fuente de verdad | Consumidores | Permiso |
| --- | --- | --- | --- |
| **Información general** | `organization.name/timezone` + `settings.general` (logo, rubro, moneda, idioma, contacto) | Zona horaria: agenda, recordatorios, resumen diario, default del nodo «Fecha y hora». Moneda: default de servicios nuevos (no pisa currency por servicio). Idioma: default del asistente del compositor. | settings:write |
| **Horario de atención** | `settings.businessHours` (hours + holidays; mismo formato del nodo) | Nodo «Fecha y hora» de workflows como DEFAULT (cada nodo puede definir horario propio que lo sobreescribe). Feriados de Chile 2026 precargables. | settings:write |
| **Plan y uso** | Solo lectura de `/billing/me` (usage_events/ai_requests) | Link a /billing para cambiar plan. | settings:write |
| **Usuarios** | Página movida desde `/users` (invitar, rol, desactivar, reset, último acceso) + matriz de roles solo lectura | `/users` redirige aquí. | users:read |
| **Equipos** | Misma página de Usuarios (ancla #equipos) | Asignaciones de Bandeja, «Asignar a» de agentes, paso «Asignar» de workflows. | users:read |
| **Etapas del ciclo de vida** | `lead_statuses` (CRUD /lifecycle-stages: nombre, emoji, color, categoría, orden drag&drop, activo). Categoría WON = conversión. Borrar exige migrar leads. | Bandeja (cabecera/clasificador/panel), Contactos, workflows (trigger + paso + catálogo solo activas), oferta CAPI, Lead Ads (fallback 1.ª OPEN activa). El engranaje de la Bandeja enlaza aquí. | leads:write |
| **Campos de contacto** | `custom_field_definitions` (CRUD /contact-fields: tipo, opciones, orden, showInList) | Ficha del contacto (drawer de Contactos); showInList = columnas disponibles en Contactos. Bloqueado borrar con valores. | contacts:write |
| **Etiquetas** | `tags` (CRUD /tags + fusionar + borrar con conteo) | Contactos, bandejas personalizadas, trigger «Etiqueta agregada», tools de agentes. | contacts:write |
| **Respuestas rápidas** | `snippets` (CRUD /inbox/snippets + ámbito team/mine) | Compositor de la Bandeja (atajo «/»; «Administrar ↗» enlaza aquí). | inbox:write |
| **Conversaciones** | `settings.inbox` (autoCloseDays/Note, botResumeMinutes, firstResponseTargetMinutes) | Tick del worker cada 10 min (auto-cierre + retoma del bot); la Bandeja marca ⏱ las no respondidas vencidas. | settings:write |
| **Ajustes de IA** | `settings.transcription`, `settings.assistantLanguage`, `prompt_templates`. Modelo/tope/rondas SOLO LECTURA («Administrado por TuBot según tu plan» — decisión 2026-07). | Transcripción: inbound de audios. Idioma: /inbox/assist. Plantillas: biblioteca copiable al editor de agentes. Canales enlaza aquí (toggle movido). | settings:write |
| **Importar contactos** | Reusa ImportModal + POST /contacts/import (misma lógica que Contactos) + historial desde audit_logs | Contactos conserva su botón (mismo modal compartido). | contacts:write |
| **Exportar datos** | `export_jobs` (BullMQ cola sync, kind export_data; CSV en BD; **expira a 7 días** con purga automática) | Descarga solo con permiso de Datos y AUDITADA (settings.export_download). | settings:write |
| **Registro de auditoría** | Vista de `audit_logs` (filtros usuario/módulo/fecha, cursor) | Solo Owner/Admin. | settings:write |
| **Canales / Integraciones** | Accesos directos (módulos propios, sin duplicar) | — | según módulo |

## Redirecciones

- `/users` → `/settings/users` · `/settings/teams` → `/settings/users#equipos`
- Bandeja: engranaje «Ciclo de vida» → `/settings/lifecycle`; compositor «Administrar respuestas rápidas ↗» → `/settings/snippets`; Canales «Transcripción» → `/settings/ia`.

## Notas técnicas

- Visibilidad del sidebar por rol vía `can()` del layout (JWT perms); **el servidor valida además el permiso en cada endpoint** (zod + withTenant + audit_logs en toda mutación).
- Búsqueda del sidebar: filtra por nombre + sinónimos (keywords por página).
- Migración `20260803120000_settings_hub`: lead_statuses.active, snippets.scope, custom_field_definitions.order/show_in_list, tablas export_jobs y prompt_templates (RLS vía setup.sql: ambas tienen organization_id).
