-- Conexión separada del CRM de Lead Ads (app Meta "TuBot CRM") por tenant.
-- Independiente de meta_business_connections para no pisar la conexión Meta
-- general (ads/CAPI). RLS se aplica dinámicamente en sql/setup.sql (columna
-- organization_id).
CREATE TABLE "meta_crm_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "business_name" TEXT,
    "app_scopes" JSONB NOT NULL DEFAULT '[]',
    "credential_id" TEXT,
    "connected_by_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_crm_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_crm_connections_organization_id_key" ON "meta_crm_connections"("organization_id");
