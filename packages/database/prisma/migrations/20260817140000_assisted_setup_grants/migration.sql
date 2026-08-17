-- CreateTable: autorización del cliente para el montaje asistido de TuBot.
-- La RLS (tenant_isolation por organization_id) y la FK a organizations las aplica
-- `pnpm db:setup` (sql/setup.sql, idempotente) al re-ejecutarse tras esta migración.
CREATE TABLE "assisted_setup_grants" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "granted_by_organization_id" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '["agents","flows","services","knowledge"]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "authorized_by_user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assisted_setup_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assisted_setup_grants_organization_id_status_idx" ON "assisted_setup_grants"("organization_id", "status");
CREATE INDEX "assisted_setup_grants_granted_by_organization_id_idx" ON "assisted_setup_grants"("granted_by_organization_id");
