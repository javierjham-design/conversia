# API (v0)

Base: `http://localhost:4000`. Auth: `Authorization: Bearer <jwt>` (excepto rutas públicas). Errores JSON estándar Nest `{statusCode, message}`.

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | /health | no | Estado del servicio |
| POST | /auth/register | no | `{email, password, name, organizationName}` → crea org+owner, devuelve `{token}` |
| POST | /auth/login | no | `{email, password}` → `{token, organizationId, role}` |
| GET | /auth/me | sí | Usuario + organización + permisos |
| GET | /organizations/me | sí | Org, sedes y contadores |
| POST | /organizations/me/clinics | sí | Crear sede |
| GET | /organizations/me/agents | sí | Agentes con versión publicada |
| GET | /organizations/me/workflows | sí | Workflows con versión publicada |
| GET | /organizations/me/usage | sí | Consumo 30 días por tipo |
| GET | /conversations?status&q | sí | Bandeja (50 últimas) |
| GET | /conversations/:id/messages | sí | Conversación + mensajes |
| POST | /conversations/:id/messages | sí | Enviar texto manual (encola envío) |
| POST | /conversations/:id/takeover | sí | Pausar IA (control humano) |
| POST | /conversations/:id/release | sí | Devolver control a la IA |
| GET | /conversations/stream/updates | sí | SSE de conversaciones actualizadas |
| GET | /webhooks/whatsapp | verify token | Verificación de Meta (hub.challenge) |
| POST | /webhooks/whatsapp | firma HMAC | Recepción de mensajes/estados |

Pendiente: CRUD de agentes/workflows/knowledge/contactos, endpoints de citas, gestión de usuarios e integraciones (se agregan por fase — ver ROADMAP.md).
