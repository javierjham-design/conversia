-- D8 — Identidad de usuario POR MARCA: el email deja de ser único global y pasa a ser
-- único por (email, brand). Permite el mismo correo como cuentas INDEPENDIENTES en
-- TuBot y Conversia. Los usuarios existentes quedan en 'tubot' (default); los que solo
-- pertenecen a orgs conversia pasan a 'conversia'.
--
-- PLAN DE REVERSA:
--   DROP INDEX IF EXISTS "users_email_brand_key";
--   CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "brand";

ALTER TABLE "users" ADD COLUMN "brand" TEXT NOT NULL DEFAULT 'tubot';

-- Backfill: usuario cuya(s) membresía(s) son SOLO de orgs conversia → brand conversia.
-- (Un usuario con alguna org tubot se queda en tubot, el default.)
UPDATE "users" u
SET "brand" = 'conversia'
WHERE EXISTS (
    SELECT 1 FROM "organization_users" ou
    JOIN "organizations" o ON o.id = ou.organization_id
    WHERE ou.user_id = u.id AND o.brand = 'conversia'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "organization_users" ou
    JOIN "organizations" o ON o.id = ou.organization_id
    WHERE ou.user_id = u.id AND o.brand <> 'conversia'
  );

-- Cambiar el unique: de email global a (email, brand).
DROP INDEX IF EXISTS "users_email_key";
CREATE UNIQUE INDEX "users_email_brand_key" ON "users" ("email", "brand");
