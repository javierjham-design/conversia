# Integración con Cláriva

Cláriva es una plataforma **externa e independiente** (SaaS de gestión clínica del mismo equipo). Conversia se integra con ella **solo** vía API + webhooks firmados. Prohibido acoplarse a su base de datos. No todos los tenants usan Cláriva: es un `SchedulingProvider` más.

Estado: **CONTRATO PRELIMINAR** — propuesto por Conversia, pendiente de validar/implementar en Cláriva. `apps/mock-clariva` implementa este contrato para desarrollar ya. Cuando Cláriva lo implemente, solo cambia `CLARIVA_BASE_URL`/credenciales.

## Autenticación

- API key por conexión de tenant: header `Authorization: Bearer <token>`.
- El token se emite en Cláriva por clínica y se guarda cifrado en `integration_credentials`.
- Webhooks de Cláriva → Conversia firmados: `X-Clariva-Signature: sha256=HMAC(secret, raw_body)` (mismo esquema que Meta).

## Endpoints (base `/api/v1`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/clinics` | Sedes de la cuenta |
| GET | `/professionals?clinicId=` | Profesionales |
| GET | `/services?clinicId=` | Prestaciones (id, name, durationMin, price, currency) |
| GET | `/professionals/:id/services` | Prestaciones por profesional |
| GET | `/availability?clinicId&professionalId&serviceId&from&to` | Slots disponibles `{start,end,professionalId,clinicId}` (ISO 8601 con TZ) |
| POST | `/appointments` | Crear cita `{clinicId, professionalId, serviceId?, patient{firstName,lastName?,phone,email?}, start, end, notes?}` → 201 / **409 slot_taken** |
| GET | `/appointments/:id` | Detalle |
| PATCH | `/appointments/:id` | Reagendar/editar |
| POST | `/appointments/:id/cancel` | Cancelar `{reason?}` |
| POST | `/appointments/:id/confirm` | Confirmar |
| POST | `/appointments/:id/attendance` | `{attended: boolean}` → completed / no_show |
| GET | `/patients/:phone/appointments` | Citas del paciente por teléfono |
| PUT | `/patients` | Crear/actualizar paciente (matching por phone) |

Requisitos transversales: idempotencia (aceptar header `Idempotency-Key` en POST), errores JSON `{error, message}`, paginación futura por cursor, rate limit documentado.

## Webhooks Cláriva → Conversia

`POST {CONVERSIA_URL}/webhooks/clariva/{connectionId}` (receptor IMPLEMENTADO) con eventos:

- `appointment.created | updated | confirmed | cancelled | rescheduled`
- `appointment.attendance` (`{attended: boolean}` → completed/no_show)
- `patient.updated`

Payload: `{event, occurredAt, data: {...appointment}}`. La URL incluye el id de la `scheduling_connection` (se entrega a Cláriva al conectar); la firma `X-Clariva-Signature` usa el secreto por-conexión `config.webhookSecret` (sin secreto configurado, el endpoint rechaza). El worker actualiza la proyección local (`appointments.external_id`, contacto por teléfono con fill-de-huecos) y dispara los triggers de workflows (`appointment_created/confirmed/cancelled/rescheduled`, `no_show`).

## Estrategia de sincronización

1. **Pull inicial** al conectar: clinics/professionals/services → tablas locales con `external_ref` (mapeo id externo ↔ interno).
2. **Webhooks** para cambios de citas (tiempo real).
3. **Reconciliación** programada (scheduled_job diario) para detectar drift.
4. La verdad de agenda vive en Cláriva; `appointments` local es una proyección con `external_id`.

## Implementación en Conversia

- Cliente: `ClarivaSchedulingProvider` (`packages/scheduling/src/index.ts`) — timeout 10s, errores tipados.
- Selección: `scheduling_connections.provider = CLARIVA` con `config {baseUrl, apiKey}` por tenant/sede.
- Mock: `apps/mock-clariva` (Express, puerto 4010) con datos en memoria y validación de doble reserva (409).
