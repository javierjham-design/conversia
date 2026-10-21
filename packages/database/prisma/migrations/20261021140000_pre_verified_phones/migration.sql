-- 2.3 — Pool de números preverificados ("número llave en mano"). Aditiva, no toca nada existente.
-- Reversa: DROP TABLE "pre_verified_phones";
CREATE TABLE "pre_verified_phones" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT 'conversia',
    "meta_phone_id" TEXT NOT NULL,
    "display_number" TEXT NOT NULL,
    "business_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'free',
    "organization_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pre_verified_phones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pre_verified_phones_meta_phone_id_key" ON "pre_verified_phones"("meta_phone_id");
CREATE INDEX "pre_verified_phones_brand_status_idx" ON "pre_verified_phones"("brand", "status");
