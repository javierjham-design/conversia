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
- **Verificador ejecutable** `pnpm --filter @conversia/database verify:isolation` (código en `packages/database/src/verify-isolation.ts`): se conecta con el **rol real de la app** (`conversia_app`, sin BYPASSRLS) y corre una matriz de 19 pruebas — lecturas filtradas tabla por tabla, acceso directo por id ajeno (→ null), UPDATE cruzado (→ 0 filas), INSERT con `organization_id` ajeno (→ rechazado por WITH CHECK), lectura sin contexto (→ 0 filas) y tablas globales (`platform_admins` invisible, `users` solo miembros). Ejecutado contra producción: **19/19 OK**.
- **Sondeo por API**: con dos sesiones (tenant A y B), B intentando leer/escribir/cerrar recursos de A recibe **404** en todos los casos (RLS filtra la fila → `findUnique` null → NotFound).

## Tablas globales (sin organization_id) — cómo se protegen

- `organizations`: política `org_self` (la app solo ve su propia fila).
- `users`: política `users_member_visibility` — el rol de app solo ve usuarios que son miembros de la organización del contexto (login/registro/invitaciones usan el cliente admin).
- `platform_admins`: RLS habilitado **sin políticas** = deny-all para el rol de app (invisible por completo).
- `plans`: RLS con política de solo lectura (catálogo público de planes).

## Superficies de inyección cerradas

- **`organization_hint`** (leads de prueba): solo se acepta desde jobs encolados por endpoints internos autenticados (`InboundJob.internal = true`); un webhook público jamás puede elegir tenant.
- **Canal simulado `mock:<slug>`**: el webhook público exige la cabecera `x-conversia-mock-token` (= `MOCK_INBOUND_TOKEN`) para aceptar payloads dirigidos a canales mock — conocer el slug de otra organización no basta para inyectarle mensajes.
- **Tráfico real de Meta**: firma HMAC-SHA256 obligatoria cuando hay `META_APP_SECRET`.

## Por qué esquema compartido y no BD-por-tenant

Cláriva (producto hermano) decidió BD física por clínica; aquí el tradeoff es distinto: se esperan muchos tenants pequeños con workflows/colas/canales compartidos y facturación por uso. RLS + esquema único da aislamiento fuerte con operación simple. Ruta de evolución: tenants enterprise pueden moverse a una BD dedicada reutilizando el mismo schema Prisma y un router de conexiones por tenant (el código ya centraliza el acceso en `withTenant`).
