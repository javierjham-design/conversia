-- A4 — sobres/paquetes de mensajes POR MARCA: una org solo ve los de su marca (no fuga de
-- pricing entre marcas). Aditiva: columna con default + índice + backfill por convención de code.
ALTER TABLE "message_packages" ADD COLUMN IF NOT EXISTS "brand" TEXT NOT NULL DEFAULT 'tubot';
CREATE INDEX IF NOT EXISTS "message_packages_brand_idx" ON "message_packages"("brand");
-- Los sobres de Conversia (code conversia* o sobre*) quedan en su marca; el resto sigue en tubot.
UPDATE "message_packages" SET "brand" = 'conversia' WHERE "code" ILIKE 'conversia%' OR "code" ILIKE 'sobre%';
