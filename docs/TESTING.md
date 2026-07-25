# Pruebas

## Estado actual

- **Unitarias (vitest)**: motor de workflows (`packages/workflows/src/engine.test.ts`: triggers, ejecución hasta espera, reanudación, ramas) y API (`apps/api/test/`: firma HMAC de Meta, permisos). `pnpm test`.
- **Simulación E2E manual**: `scripts/simulate-inbound.mjs` (payload Meta real → webhook → worker → agente → respuesta mock visible en consola y bandeja). Requiere BD+Redis+seed.
- **Mocks disponibles**: MockAIProvider (sin API key), MockChannelProvider (sin Meta), MockSchedulingProvider (agenda con doble reserva), mock-clariva (contrato HTTP completo).

## Plan (en orden de valor)

1. **Aislamiento multi-tenant (crítico)**: test de integración con Postgres real (docker) — conectar como `conversia_app`, sembrar 2 tenants, verificar que `withTenant(A)` no lee/escribe datos de B (contacts, conversations, knowledge, workflows) y que sin GUC no se lee nada.
2. **Idempotencia**: mismo wamid dos veces → un solo mensaje; mismo evento → un solo run (unique idempotency_key).
3. **Orquestador**: con MockAIProvider scriptado (tool_use forzado) validar loop de tools, transferencia entre agentes y escalamiento humano.
4. **Doble reserva**: dos createAppointment concurrentes al mismo slot → exactamente una cita (mock ya valida; probar también contra mock-clariva 409).
5. **Cancelación de esperas**: run en WAITING + mensaje entrante → timer CANCELLED y run CANCELLED.
6. **Webhooks**: firmas inválidas rechazadas (unit ya cubre la función; agregar test HTTP del controller).
7. **Contratos**: tests del ClarivaSchedulingProvider contra apps/mock-clariva levantado (pact-style ligero).
8. **Carga**: N mensajes concurrentes por tenant — colas y RLS bajo concurrencia.

Infra sugerida: vitest en todos los paquetes + testcontainers (o docker compose de CI) para Postgres/Redis en tests de integración.
