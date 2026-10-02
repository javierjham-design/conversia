-- D6 — Verificación de correo: columna email_verified_at en users (null = sin verificar).
-- Los usuarios EXISTENTES quedan verificados (grandfather): no se les molesta. Solo los
-- registros NUEVOS (default null) deberán confirmar su correo con el link.
--
-- PLAN DE REVERSA:
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified_at";

ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
