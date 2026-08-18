-- Catálogo comercial normalizado (unifica productos de tienda, menús de restaurante y
-- el catálogo manual de Servicios). Aditivo: no toca `services` (la unificación se hace
-- por backfill posterior, ver docs/CATALOGS.md y el reporte).
CREATE TABLE IF NOT EXISTS "catalog_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "external_id" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'product',
  "sku" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "bot_description" TEXT,
  "category" TEXT,
  "subcategory" TEXT,
  "price" DECIMAL(12,2),
  "compare_at_price" DECIMAL(12,2),
  "currency" TEXT NOT NULL DEFAULT 'CLP',
  "stock" INTEGER,
  "track_stock" BOOLEAN NOT NULL DEFAULT false,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "variants" JSONB NOT NULL DEFAULT '[]',
  "image_url" TEXT,
  "product_url" TEXT,
  "buy_url" TEXT,
  "tags" JSONB NOT NULL DEFAULT '[]',
  "menu_section" TEXT,
  "availability" JSONB NOT NULL DEFAULT '{}',
  "service_id" TEXT,
  "raw" JSONB NOT NULL DEFAULT '{}',
  "embedding" vector(1536),
  "synced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_items_org_source_external_key" ON "catalog_items" ("organization_id", "source", "external_id");
CREATE INDEX IF NOT EXISTS "catalog_items_org_kind_active_idx" ON "catalog_items" ("organization_id", "kind", "active");
CREATE INDEX IF NOT EXISTS "catalog_items_org_category_idx" ON "catalog_items" ("organization_id", "category");

CREATE TABLE IF NOT EXISTS "catalog_sync_runs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "created" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "deactivated" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "catalog_sync_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "catalog_sync_runs_org_started_idx" ON "catalog_sync_runs" ("organization_id", "started_at");
