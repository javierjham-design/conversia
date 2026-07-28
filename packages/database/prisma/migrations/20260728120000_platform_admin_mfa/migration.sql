-- Fase seguridad (Super Admin): MFA TOTP + RBAC para administradores de plataforma.
-- 100% aditivo y reversible. Las sesiones revocables viven en Redis (sin esquema).
-- Rollback:
--   ALTER TABLE "platform_admins" DROP COLUMN "mfa_recovery_codes";
--   ALTER TABLE "platform_admins" DROP COLUMN "mfa_enabled_at";
--   ALTER TABLE "platform_admins" DROP COLUMN "mfa_secret";
--   ALTER TABLE "platform_admins" DROP COLUMN "role";

ALTER TABLE "platform_admins" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE "platform_admins" ADD COLUMN "mfa_secret" TEXT;
ALTER TABLE "platform_admins" ADD COLUMN "mfa_enabled_at" TIMESTAMP(3);
ALTER TABLE "platform_admins" ADD COLUMN "mfa_recovery_codes" JSONB NOT NULL DEFAULT '[]';
