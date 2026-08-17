-- Vinculación por CÓDIGO CORTO + scope de canal para el montaje asistido.
-- El cliente autoriza en su panel, elige el canal a configurar y recibe un código
-- (tipo TB-XXXX-XXXX, guardado como hash) que le dicta al bot para vincular la
-- conversación con su cuenta. Aditivo: columnas nullable, sin backfill.
ALTER TABLE "assisted_setup_grants"
  ADD COLUMN IF NOT EXISTS "redeem_code_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "redeem_code_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "redeemed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "scope_channel_id" TEXT;

CREATE INDEX IF NOT EXISTS "assisted_setup_grants_redeem_code_hash_idx"
  ON "assisted_setup_grants" ("redeem_code_hash");
