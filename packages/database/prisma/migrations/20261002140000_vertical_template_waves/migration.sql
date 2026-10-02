-- F2 complemento (catálogo de rubros docs/CONVERSIA_RUBROS.md): metadatos de la plantilla
-- vertical para gobernar olas, estado (active/beta), variante de producto y features exigidas.
-- Aditivo y seguro: columnas con default; las plantillas existentes quedan wave=1/active/citas.
--
-- PLAN DE REVERSA:
--   ALTER TABLE "vertical_templates" DROP COLUMN IF EXISTS "wave", DROP COLUMN IF EXISTS "status",
--     DROP COLUMN IF EXISTS "variant", DROP COLUMN IF EXISTS "requires_feature";

ALTER TABLE "vertical_templates" ADD COLUMN "wave" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "vertical_templates" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "vertical_templates" ADD COLUMN "variant" TEXT NOT NULL DEFAULT 'citas';
ALTER TABLE "vertical_templates" ADD COLUMN "requires_feature" JSONB NOT NULL DEFAULT '[]';
