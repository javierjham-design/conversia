-- F5 — Planes Conversia + precios sellados. ADITIVA.
--
-- PLAN DE REVERSA:
--   DROP INDEX IF EXISTS "plans_brand_idx";
--   ALTER TABLE "plans" DROP COLUMN IF EXISTS "brand";
--   ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "locked_price_clp";
--   ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "locked_price_usd";

ALTER TABLE "plans" ADD COLUMN "brand" TEXT NOT NULL DEFAULT 'tubot';
CREATE INDEX "plans_brand_idx" ON "plans" ("brand");

ALTER TABLE "subscriptions" ADD COLUMN "locked_price_clp" DECIMAL(12,0);
ALTER TABLE "subscriptions" ADD COLUMN "locked_price_usd" DECIMAL(10,2);

-- Backfill: sella en cada suscripción ACTIVA/TRIALING/PAST_DUE el precio ACTUAL de su
-- plan, para que un cambio futuro del "precio de lanzamiento" no las re-precie.
UPDATE "subscriptions" s
SET "locked_price_clp" = p."price_clp",
    "locked_price_usd" = p."price_usd"
FROM "plans" p
WHERE s."plan_id" = p."id"
  AND s."status" IN ('ACTIVE', 'TRIALING', 'PAST_DUE')
  AND s."locked_price_clp" IS NULL;
