-- =============================================================
-- Conversia — Endurecimiento de base de datos (ejecutar como admin
-- DESPUÉS de `prisma migrate`). Idempotente: se puede re-ejecutar
-- tras cada migración para cubrir tablas nuevas.
--   pnpm db:setup
-- Hace 4 cosas:
--   1. Extensión pgvector + índice HNSW para RAG.
--   2. Rol de aplicación `conversia_app` (sin BYPASSRLS).
--   3. RLS: política tenant_isolation en TODA tabla con columna
--      organization_id, usando current_setting('app.org_id').
--   4. FK dinámica organization_id -> organizations(id) donde falte.
-- La app debe conectarse como conversia_app en producción y setear
-- app.org_id por transacción (ver withTenant en @conversia/database).
-- =============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- Índice vectorial para búsqueda semántica (cosine)
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- Búsqueda semántica del catálogo comercial (mismo esquema pgvector).
CREATE INDEX IF NOT EXISTS catalog_items_embedding_idx
  ON catalog_items USING hnsw (embedding vector_cosine_ops);

-- 2. Rol de aplicación (cambiar password vía ALTER ROLE en producción)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'conversia_app') THEN
    CREATE ROLE conversia_app LOGIN PASSWORD 'conversia_app_dev_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO conversia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO conversia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO conversia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO conversia_app;

-- 3. RLS dinámico sobre toda tabla con organization_id
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'organization_id'
      AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    -- FORCE: la RLS aplica INCLUSO al dueño de la tabla (solo el superusuario/BYPASSRLS
    -- la evade). Defensa en profundidad por si la app llega a conectar como dueño.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    -- Filas con organization_id NULL (plantillas globales, logs de plataforma)
    -- solo son visibles para roles que bypasean RLS (admin), no para la app.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (organization_id = current_setting(''app.org_id'', true)) '
      'WITH CHECK (organization_id = current_setting(''app.org_id'', true))',
      r.table_name
    );
  END LOOP;
END $$;

-- Tablas globales sin organization_id (organizations, users, plans,
-- platform_admins): el aislamiento se aplica en la capa de aplicación.
-- Para organizations, política adicional: la app solo ve su propia fila.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON public.organizations;
CREATE POLICY org_self ON public.organizations
  USING (id = current_setting('app.org_id', true));
-- Nota: crear organizaciones (registro) se hace con la conexión admin
-- (DIRECT_DATABASE_URL) — ver AuthService.

-- users (identidad global): el rol de app solo ve usuarios que son miembros
-- de la organización del contexto. Login/registro/invitaciones usan admin.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_member_visibility ON public.users;
CREATE POLICY users_member_visibility ON public.users
  USING (EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.user_id = users.id
      AND ou.organization_id = current_setting('app.org_id', true)
  ));

-- platform_admins: invisible e inmodificable para el rol de app
-- (RLS habilitado sin políticas = deny-all para no-bypass).
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_app ON public.platform_admins;

-- plans: solo lectura para el rol de app
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_read ON public.plans;
CREATE POLICY plans_read ON public.plans FOR SELECT USING (true);

-- 4. FK organization_id -> organizations(id) donde no exista ya una FK
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'organization_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'organizations'
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint pc
      JOIN pg_class pcl ON pcl.oid = pc.conrelid
      JOIN pg_attribute pa
        ON pa.attrelid = pcl.oid AND pa.attnum = ANY (pc.conkey)
      WHERE pc.contype = 'f'
        AND pcl.relname = r.table_name
        AND pa.attname = 'organization_id'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) '
        'REFERENCES public.organizations(id) ON DELETE CASCADE',
        r.table_name, r.table_name || '_organization_fk'
      );
    END IF;
  END LOOP;
END $$;
