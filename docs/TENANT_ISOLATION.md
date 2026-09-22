# Aislamiento de datos por tenant — opciones, costos y plan por fases

> Documento de decisión. Compara cómo aislar los datos de los tenants de Conversia
> (hoy RLS compartido) y recomienda un camino. Contexto: **Cláriva convive en la
> misma cuenta de Railway**; existe una decisión previa de "DB física por clínica"
> para el producto dental (`project_db_per_tenant`) que **nunca se aplicó a Conversia**.

## 1. Estado actual (lo que hay hoy)

- **Una sola base Postgres** para todos los tenants. ~80 de las 88 tablas llevan
  `organization_id` (tablas de tenant); el resto son de plataforma (organizations,
  users, plans, subscriptions, platform_settings, coupons, audit de plataforma).
- **Aislamiento por RLS (Row-Level Security) por fila**: `sql/setup.sql` agrega
  dinámicamente una política sobre **toda** tabla con `organization_id`, del tipo
  `organization_id = current_setting('app.org_id')`.
- **Dos roles de BD**:
  - `conversia_app` (rol de la app) — **NO puede saltarse RLS** (sin BYPASSRLS). Es la
    barrera real. Todo acceso a datos de tenant pasa por `withTenant(orgId, fn)`, que
    hace `SET LOCAL app.org_id` dentro de la transacción.
  - Rol admin/superusuario (`DIRECT_DATABASE_URL`) — bypassa RLS. **Solo** para
    operaciones de plataforma cross-tenant (registro, login, resolución de tenant por
    canal, scheduler, montaje asistido). Se usa en poquísimos lugares.
- Existe `packages/database/src/verify-isolation.ts` que prueba que un tenant no ve a
  otro.

### Modelo de amenazas — qué protege RLS y qué no
- ✅ **Fuga de la credencial de la app** (`conversia_app`): NO cruza tenants. El rol no
  puede desactivar RLS y cada fila se filtra por `org_id`.
- ✅ **Un tenant intentando leer a otro** vía la app: imposible por RLS.
- ⚠️ **Fuga de la credencial admin/superusuario**: sí expondría todo. Mitigación: URL
  blindada, uso mínimo, y (pendiente) rotación + secretos gestionados.
- ⚠️ **Inyección SQL que setee otro `org_id`**: mitigado porque se usa Prisma
  (parametrizado) y el `org_id` viene del JWT/canal, nunca del cliente.
- ⚠️ **Bug de código que olvide `withTenant`**: mitigado por `verify-isolation`
  (conviene ampliarlo y correrlo en CI).

**Conclusión:** el RLS bien hecho ya da aislamiento lógico fuerte. Lo que NO da es
aislamiento **físico**: todo vive en la misma base, así que una brecha del nodo o de la
credencial raíz expone a todos. Ahí es donde entran las otras opciones.

## 2. Restricción técnica clave: Prisma y el schema

Prisma **"quema" el nombre del schema en cada query en tiempo de `generate`**
(`"public"."messages"`). No existe cambio de schema por request en runtime: un
`SET search_path` en la transacción **Prisma lo ignora** porque ya calificó la tabla.
La feature `multiSchema` exige una lista **fija y enumerable** de schemas — no sirve
para "un schema nuevo por cada tenant" creado dinámicamente.

Consecuencia directa sobre las opciones:
- **Schema-por-tenant pelea con Prisma** (habría que usar 1 cliente por schema, o
  reescribir el acceso a datos en SQL crudo).
- **DB-por-tenant encaja bien con Prisma**: basta cambiar el `url` del datasource al
  construir el cliente — `getAdminPrisma()` ya hace exactamente eso.

## 3. Las tres opciones en detalle

### Opción A — Endurecer el RLS compartido (evolución de lo actual)
Mantener una base + RLS, y reforzar:
- Auditoría automatizada de que **toda** tabla de tenant tiene política (test en CI que
  falle si aparece una tabla con `organization_id` sin RLS).
- Blindar el rol admin: inventario de cada uso del `DIRECT_DATABASE_URL`, y mover
  secretos a un gestor con rotación.
- Ampliar `verify-isolation` (lecturas, escrituras, joins, agregados) y correrlo en CI.
- Opcional: columna de "tenant" en índices críticos ya está; revisar que no haya
  queries admin que filtren mal.

| Aspecto | Valoración |
|---|---|
| Encaje con Prisma | Perfecto (ya está) |
| Aislamiento | Lógico alto; físico nulo |
| Esfuerzo | **Bajo** (días) |
| Costo Railway | Sin cambio |
| Ops (backup/migración/monitoreo) | Sin cambio (1 base) |
| Consultas de plataforma (MRR, super admin) | Sin cambio |
| Riesgo | Bajo |

### Opción B — Schema-por-tenant (un schema Postgres por tenant, misma base)
Cada tenant tiene su schema (`tenant_<id>`) con sus ~80 tablas; las tablas de
plataforma quedan en `public`.

- **Encaje con Prisma: malo** (ver §2). Caminos: (1) un `PrismaClient` por schema
  → multiplica conexiones (contradice el fix de `connection_limit`) y memoria; o (2)
  reescribir el acceso a datos de tenant en SQL crudo → se abandona el query builder.
- **Provisioning**: al crear un tenant hay que crear el schema + ~80 tablas + índices
  + extensiones (vector) desde una plantilla.
- **Migraciones ×N schemas**: cada cambio de esquema corre contra todos los schemas;
  hay que construir un runner idempotente y tolerante a fallos parciales.
- **Aislamiento**: mayor que tablas compartidas, pero comparte instancia/credenciales;
  una brecha del nodo sigue exponiendo todo.

| Aspecto | Valoración |
|---|---|
| Encaje con Prisma | **Malo** |
| Aislamiento | Medio (comparte instancia) |
| Esfuerzo | **Alto** (semanas; reescritura de acceso a datos o 1 cliente/schema) |
| Costo Railway | Casi sin cambio (misma instancia) |
| Ops | Provisioning + migraciones ×N |
| Consultas de plataforma | Complejas (fan-out por schema) |
| Riesgo | Alto (fricción con Prisma) |

**Veredicto: peor ROI.** Casi todos los dolores operativos de DB-por-tenant, con menos
aislamiento y el peor encaje técnico.

### Opción C — DB física por tenant (una base Postgres por tenant)
Cada tenant, su propia base. Un `PrismaClient` por tenant apuntando a su `url`
(patrón que ya usa `getAdminPrisma`), cacheado y con `connection_limit` chico.

- **Encaje con Prisma: bueno** (swap de URL, mismo cliente generado).
- **Aislamiento: máximo** — una brecha de credenciales de un tenant solo expone ESE
  tenant; ni la base raíz ni las de otros clientes.
- **Provisioning**: crear una base por tenant (en Railway, cada Postgres es un servicio
  con su costo y su volumen) + correr todas las migraciones + `setup.sql`.
- **Migraciones ×N bases**: runner que aplique `migrate deploy` a cada base; ventana de
  despliegue más larga; manejo de fallos parciales y versión por base.
- **Conexiones**: N pools (uno por base activa). Hay que cachear clientes por tenant y
  cerrar los inactivos; el `connection_limit` por cliente es crítico.
- **Consultas de plataforma (MRR, super admin, este monitor)**: dejan de ser un
  `SELECT` global. Opciones: (a) mantener las tablas de plataforma en una base central
  (organizations/subscriptions/plans/invoices) y solo los DATOS de tenant en su base;
  (b) un proceso que agregue métricas por tenant. La opción (a) es la sana.
- **Costo Railway**: sube de forma lineal con la cantidad de tenants (una instancia
  Postgres por tenant, o al menos un plan que lo permita). A decenas/cientos de tenants
  esto pesa; ahí conviene un Postgres administrado externo (Neon/RDS) con creación de
  bases por API — alineado con "Hetzner/destino futuro".

| Aspecto | Valoración |
|---|---|
| Encaje con Prisma | Bueno (swap de URL) |
| Aislamiento | **Máximo** (físico) |
| Esfuerzo | Alto (semanas: provisioning + runner + refactor de plataforma) |
| Costo Railway | **Sube lineal** con #tenants |
| Ops | Backups/migraciones/monitoreo ×N |
| Consultas de plataforma | Requieren base central o agregación |
| Riesgo | Medio (patrón conocido, pero mucha infra) |

## 4. Comparativa rápida

| | A. RLS endurecido | B. Schema/tenant | C. DB/tenant |
|---|---|---|---|
| Encaje Prisma | ✅ | ❌ | ✅ |
| Aislamiento | Lógico alto | Medio | **Físico máximo** |
| Esfuerzo | Bajo | Alto | Alto |
| Costo Railway | = | ≈ | Sube lineal |
| Migraciones | 1 | ×N | ×N |
| Consultas plataforma | Simples | Fan-out | Base central |
| ROI seguridad | Alto | Bajo | Medio-alto |

## 5. Recomendación y plan por fases

El punto medio elegido (schema-por-tenant) es, en este stack, el de peor ROI. Se
recomienda:

**Fase 1 — Endurecer RLS (ya, barato).** Auditoría de políticas + test en CI que falle
si una tabla de tenant no tiene RLS; ampliar `verify-isolation`; inventariar y blindar
cada uso del rol admin; rotación de secretos. Sube el piso de seguridad sin
re-arquitectura. *(Ganancia inmediata, sirva cual sea el rumbo final.)*

**Fase 2 — Construir el "provisioning + runner de migraciones por tenant".** Es la pieza
común que necesitan tanto schema-por-tenant como DB-por-tenant. Construirla apuntando a
**DB-por-tenant** (el endgame limpio con Prisma): crear base, correr migraciones +
`setup.sql`, registrar versión por tenant, cachear clientes con `connection_limit`.

**Fase 3 — Separar plataforma de datos de tenant.** Mover a una base central las tablas
de plataforma (organizations, users, plans, subscriptions, invoices, platform_settings)
para que el super admin, MRR y el monitor sigan siendo consultas simples cuando los
datos de tenant estén en bases separadas.

**Fase 4 — Piloto DB-por-tenant** con 1–2 tenants nuevos (ej. clientes enterprise o de
salud que lo exijan), medir costo/ops en Railway, y decidir si se migra el resto o se
ofrece "base dedicada" como feature premium (los demás siguen en RLS endurecido).

### Nota sobre costo/infra
A escala, una base Postgres por tenant en Railway pesa en costo. El endgame natural es
un Postgres administrado con creación de bases por API (Neon/RDS/Cloud SQL) — coherente
con el "destino futuro Hetzner/administrado". DB-por-tenant se puede ofrecer como
**nivel premium** en vez de para todos, dejando a la mayoría en RLS endurecido.

## 6. Decisión pendiente
Elegir entre: (1) solo Fase 1 (RLS endurecido) por ahora; (2) Fases 1→4 hacia
DB-por-tenant (como default o como premium); (3) forzar schema-por-tenant asumiendo el
costo técnico. Recomendado: **Fase 1 ya + Fases 2–4 hacia DB-por-tenant como opción
premium**, no como migración masiva inmediata.
