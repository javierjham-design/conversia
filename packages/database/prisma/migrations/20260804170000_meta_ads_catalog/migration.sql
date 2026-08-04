-- CreateTable: catálogo de anuncios de Meta por organización.
CREATE TABLE "meta_ads" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "adset_id" TEXT NOT NULL,
    "adset_name" TEXT NOT NULL,
    "ad_external_id" TEXT NOT NULL,
    "ad_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "objective" TEXT,
    "is_ctwa" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_ads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_ads_organization_id_ad_external_id_key" ON "meta_ads"("organization_id", "ad_external_id");

-- CreateIndex
CREATE INDEX "meta_ads_organization_id_campaign_id_idx" ON "meta_ads"("organization_id", "campaign_id");

-- RLS: aislamiento por tenant (mismo patrón que sql/setup.sql; incluido aquí
-- para que la tabla NUNCA quede sin aislamiento aunque no se re-corra setup.sql).
ALTER TABLE "meta_ads" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "meta_ads";
CREATE POLICY tenant_isolation ON "meta_ads"
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));

-- Permisos del rol de aplicación (idempotente si setup.sql ya los concede).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'conversia_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meta_ads" TO conversia_app;
  END IF;
END $$;
