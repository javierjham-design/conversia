-- F1 — Backend brand-aware. ADITIVA, con defaults → cero cambios para datos existentes.
--
-- PLAN DE REVERSA:
--   DROP INDEX IF EXISTS "organizations_brand_idx";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "brand";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "settings";

ALTER TABLE "organizations" ADD COLUMN "brand" TEXT NOT NULL DEFAULT 'tubot';
CREATE INDEX "organizations_brand_idx" ON "organizations" ("brand");

ALTER TABLE "users" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';
