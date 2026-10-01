-- F2 — Paquetes verticales. ADITIVA. organizationId NULL = catálogo global; el loop de
-- RLS de sql/setup.sql (toda tabla con organization_id) la protege: las filas globales
-- (NULL) quedan invisibles/inmutables para el rol de app, y el instalador/endpoints la
-- leen con el cliente admin. Re-ejecutar `pnpm db:setup` tras aplicar esta migración.
--
-- PLAN DE REVERSA:
--   DROP TABLE IF EXISTS "vertical_templates";

CREATE TABLE "vertical_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vertical_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vertical_templates_key_version_key" ON "vertical_templates" ("key", "version");
CREATE INDEX "vertical_templates_key_active_idx" ON "vertical_templates" ("key", "active");
