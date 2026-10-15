-- V2-8 — cola de excepciones de la consola. Por-org (RLS la cubre vía setup.sql); la consola
-- lee cross-org con el cliente admin. Aditiva. Reversa: DROP TABLE platform_exceptions;
CREATE TABLE "platform_exceptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "dedupe_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_to_id" TEXT,
    "resolution" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_exceptions_status_created_at_idx" ON "platform_exceptions"("status", "created_at");
CREATE INDEX "platform_exceptions_organization_id_type_status_idx" ON "platform_exceptions"("organization_id", "type", "status");
