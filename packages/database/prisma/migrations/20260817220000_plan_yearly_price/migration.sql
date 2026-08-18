-- Un mismo plan con precio mensual Y anual; la cadencia se elige al suscribir.
-- Aditivo: columnas nullable + interval en subscriptions (default monthly).
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "price_usd_yearly" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "price_clp_yearly" DECIMAL(12,0);

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "interval" TEXT NOT NULL DEFAULT 'monthly';

-- Backfill: suscripciones existentes cuya cadencia real venía del plan yearly.
UPDATE "subscriptions" s
  SET "interval" = 'yearly'
  FROM "plans" p
  WHERE s."plan_id" = p."id" AND p."interval" = 'yearly';
