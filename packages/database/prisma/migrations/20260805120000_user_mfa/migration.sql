-- MFA (TOTP) por usuario. Aditivo y seguro: columnas con defaults, no rompe filas
-- existentes. El secreto va cifrado AES-256-GCM; los códigos de recuperación, hasheados.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_recovery_codes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enrolled_at" TIMESTAMP(3);
