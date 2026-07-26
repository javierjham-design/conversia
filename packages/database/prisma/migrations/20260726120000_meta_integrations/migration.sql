-- CreateEnum
CREATE TYPE "MetaConnectionMode" AS ENUM ('EMBEDDED', 'MANUAL', 'MOCK');

-- CreateEnum
CREATE TYPE "MetaConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "clinic_id" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "headers" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "max_retries" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "timeout_ms" INTEGER NOT NULL DEFAULT 10000;

-- CreateTable
CREATE TABLE "meta_business_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "MetaConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "MetaConnectionMode" NOT NULL DEFAULT 'MANUAL',
    "business_id" TEXT,
    "business_name" TEXT,
    "app_scopes" JSONB NOT NULL DEFAULT '[]',
    "credential_id" TEXT,
    "connected_by_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_business_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_assets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meta_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_field_mappings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "form_external_id" TEXT,
    "mappings" JSONB NOT NULL DEFAULT '[]',
    "config" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_event_mappings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "dataset_id" TEXT,
    "test_event_code" TEXT,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_event_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "message" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_business_connections_organization_id_key" ON "meta_business_connections"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_assets_organization_id_kind_external_id_key" ON "meta_assets"("organization_id", "kind", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_field_mappings_organization_id_form_external_id_key" ON "meta_field_mappings"("organization_id", "form_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_event_mappings_organization_id_key" ON "meta_event_mappings"("organization_id");

-- CreateIndex
CREATE INDEX "integration_events_organization_id_provider_created_at_idx" ON "integration_events"("organization_id", "provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

