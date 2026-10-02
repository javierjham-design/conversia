-- D8 — Super admin SEPARADO por marca: el email del super admin deja de ser único
-- global y pasa a ser único por (email, brand). Permite el mismo correo como super
-- admin INDEPENDIENTE de TuBot y de Conversia. Los existentes quedan en 'tubot'.
--
-- PLAN DE REVERSA:
--   DROP INDEX IF EXISTS "platform_admins_email_brand_key";
--   CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins" ("email");
--   ALTER TABLE "platform_admins" DROP COLUMN IF EXISTS "brand";

ALTER TABLE "platform_admins" ADD COLUMN "brand" TEXT NOT NULL DEFAULT 'tubot';

-- Cambiar el unique: de email global a (email, brand).
DROP INDEX IF EXISTS "platform_admins_email_key";
CREATE UNIQUE INDEX "platform_admins_email_brand_key" ON "platform_admins" ("email", "brand");
