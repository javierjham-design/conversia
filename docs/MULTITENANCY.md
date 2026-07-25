# Multi-tenancy y aislamiento

Requisito no negociable: ningún tenant puede ver, usar o afectar datos de otro. Defensa en profundidad con 5 capas.

## Capa 1 — Modelo de datos

- Toda tabla de datos de tenant lleva `organization_id` (y `clinic_id` cuando aplica).
- `sql/setup.sql` agrega dinámicamente FK `organization_id → organizations(id)` a toda tabla que la tenga (cobertura automática de tablas futuras).
- Unicidades compuestas por tenant: `(organization_id, slug|code|name|external_id)`.

## Capa 2 — Row Level Security (Postgres)

- `sql/setup.sql` habilita RLS y crea la política `tenant_isolation` en **todas** las tablas con `organization_id`:
  `USING/WITH CHECK (organization_id = current_setting('app.org_id', true))`.
- La aplicación se conecta como rol `conversia_app` (sin BYPASSRLS). Migraciones/seeds usan la conexión admin (`DIRECT_DATABASE_URL`).
- `withTenant(orgId, fn)` (`@conversia/database`) abre una transacción y setea `app.org_id` con `set_config(..., true)` (local a la transacción). **Es la única vía autorizada para tocar datos de tenant.**
- Filas con `organization_id NULL` (plantillas globales, logs de plataforma) son invisibles para el rol de app; solo el admin de plataforma las gestiona.
- `organizations` tiene política `org_self` (la app solo ve su propia fila). Crear organizaciones (registro) es operación de plataforma → conexión admin. **Pendiente de endurecer**: hoy `AuthService.register` usa el cliente por defecto; antes de producción debe separarse un `PrismaClient` admin dedicado.

## Capa 3 — Aplicación

- El `organizationId` **jamás** se acepta del cliente. Fuentes válidas:
  - API autenticada: JWT (`TenancyMiddleware` → AsyncLocalStorage → `requireContext()`).
  - Webhooks: resolución por canal receptor (`phone_number_id` → `whatsapp_phone_numbers`, o `mock:<slug>`). Este lookup de ruteo es el único acceso global del worker.
- Todos los jobs de cola llevan `organizationId` (o payload crudo que se resuelve a tenant antes de tocar datos).
- Las tools de IA reciben `ToolContext` con el tenant ya fijado; cada servicio abre su propio `withTenant`. El modelo nunca ve ni envía IDs de organización.

## Capa 4 — Servicios auxiliares

- **Redis/colas**: nombres de cola globales, payloads con tenant; los índices de idempotencia son por tenant (`(organization_id, external_id)`).
- **Archivos (S3)**: clave con prefijo `{organizationId}/...` (campo `files.key`).
- **RAG**: `knowledge_chunks` filtra por `organization_id` vía RLS incluso en búsqueda vectorial (la query corre dentro de `withTenant`).
- **Credenciales**: `integration_credentials.ciphertext` AES-256-GCM con clave de plataforma (`CREDENTIALS_ENCRYPTION_KEY`) + `key_version` para rotación.

## Capa 5 — Auditoría y pruebas

- `audit_logs` con actor, acción, entidad y contexto de organización.
- `ai_requests` + `usage_events` registran consumo/costo por tenant.
- Pruebas de aislamiento pendientes de automatizar (ver TESTING.md): crear 2 tenants (los seeds ya crean `digital-dent` y `clinica-demo`) y verificar que consultas cruzadas devuelven vacío bajo el rol `conversia_app`.

## Por qué esquema compartido y no BD-por-tenant

Cláriva (producto hermano) decidió BD física por clínica; aquí el tradeoff es distinto: se esperan muchos tenants pequeños con workflows/colas/canales compartidos y facturación por uso. RLS + esquema único da aislamiento fuerte con operación simple. Ruta de evolución: tenants enterprise pueden moverse a una BD dedicada reutilizando el mismo schema Prisma y un router de conexiones por tenant (el código ya centraliza el acceso en `withTenant`).
