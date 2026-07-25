# Roadmap y backlog del MVP

Fases del brief (44) con estado real. ✅ hecho · 🔶 parcial · ⬜ pendiente.

## Fase 1 — Núcleo SaaS multi-tenant
- ✅ Monorepo pnpm+turbo, CI básico
- ✅ Esquema Prisma (~50 tablas) + RLS dinámico + FKs + rol de app
- ✅ Auth (registro/login/JWT) + contexto de tenant (ALS) + roles/permisos por org
- ✅ Organizaciones, sedes, equipos, auditoría, usage_events
- ⬜ Gestión de usuarios/invitaciones UI · ⬜ Cliente Prisma admin separado para operaciones de plataforma · ⬜ Archivos S3

## Fase 2 — Conversaciones y WhatsApp
- ✅ Webhook Meta (verify + firma HMAC) → cola → worker
- ✅ Resolución de tenant por número, contactos+identidades, conversaciones, mensajes idempotentes
- ✅ Envío (Meta real + Mock), estados sent/delivered/read
- ✅ Bandeja v0 (lista, chat, envío manual, tomar control / devolver a IA)
- 🔶 Tiempo real (sondeo 4s; falta pub/sub) · ⬜ Media (imágenes/audio/documentos) · ⬜ Plantillas + ventana 24h · ⬜ Multi-número UI

## Fase 3 — Agentes IA
- ✅ AIProvider (Anthropic + Mock), registro de costos por request
- ✅ Agentes + versiones publicables (seed), prompts con variables
- ✅ 9 tools core validadas con zod (precios, agenda, lead, tags, KB, transferencias)
- ✅ Orquestador v0: agente activo por canal, loop de tools, transferencia agente↔agente y a humano
- 🔶 RAG (búsqueda textual; falta pgvector+embeddings) · ⬜ CRUD/editor de agentes en panel · ⬜ Simulador de conversaciones UI · ⬜ A/B y métricas por versión · ⬜ Detección de intención/sentimiento como paso separado (Haiku)

## Fase 4 — Workflows
- ✅ Motor puro testeado: triggers, nodos v0 (send_text, run_agent, wait, condition, lead, tags, human, stop), ramas, timers persistentes, cancelación por respuesta, idempotencia de runs
- ✅ Versionado (draft/published, el run fija su versión)
- ⬜ Editor visual (React Flow) · ⬜ Más nodos (call_api con protección SSRF, plantillas WhatsApp, subflujos) · ⬜ Variables tipadas y expresiones seguras · ⬜ Métricas por nodo

## Fase 5 — Agendamiento e integraciones
- ✅ Contrato SchedulingProvider completo + MockSchedulingProvider (doble reserva) + ClarivaSchedulingProvider + mock server del contrato
- ✅ Selección de proveedor por tenant (scheduling_connections)
- ⬜ Receptor de webhooks Cláriva · ⬜ Google Calendar / Dentalink · ⬜ Meta Lead Ads + Conversions API · ⬜ Recordatorios/confirmaciones programados (workflow plantilla existe; falta trigger appointment_upcoming automático)

## Fase 6 — Piloto Digital Dent
- ✅ Tenant por seed JSON (org, sede Temuco, equipos, 17 estados de lead, 7 servicios, 3 profesionales placeholder, 3 agentes, 2 workflows, canal mock)
- ⬜ Datos reales (precios/profesionales/FAQ) · ⬜ Conectar número WhatsApp real · ⬜ Operación en paralelo + comparación · ⬜ Conexión Cláriva real

## Fase 7 — Nuevos clientes
- ✅ Segundo tenant demo por seed (prueba de aislamiento)
- ⬜ Onboarding UI 16 pasos · ⬜ Planes/límites activos (entidades listas) · ⬜ Facturación · ⬜ White-label · ⬜ Refresh tokens/2FA

## Próximos 10 tickets sugeridos (orden)
1. Levantar Postgres+Redis (Docker o Railway), `db:migrate + db:setup + db:seed`, probar E2E con simulador.
2. Test automatizado de aislamiento RLS (2 tenants, rol conversia_app).
3. Cliente Prisma admin separado para registro/lookup de ruteo.
4. Embeddings (OpenAI) + búsqueda pgvector en searchKnowledgeBase.
5. Trigger `appointment_upcoming` (scheduled_job por cita) para confirmaciones.
6. CRUD de agentes y prompts en panel (editar borrador → publicar versión).
7. Recepción de media (imágenes/audio) + transcripción (AIProvider.transcribe).
8. Plantillas de WhatsApp (sincronización + envío fuera de ventana 24h).
9. Editor visual de workflows (React Flow) sobre el JSON existente.
10. Panel de métricas (conversaciones, conversión a cita, costo IA por tenant).

## Criterios de aceptación del MVP (sección 45 del brief)
Cumplidos por diseño/seed: 1,2,3,4(mock),5,6,7,8,9,10,11,12,17(textual),21,23,24,29(mock vs clariva),30. Pendientes de infraestructura levantada y verificación: el resto (requieren BD corriendo y panel ampliado).
