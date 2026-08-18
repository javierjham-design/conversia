-- Enriquecimiento del catálogo: galería de imágenes + atributos flexibles + marca/código/unidad,
-- para que el bot responda con TODA la info del producto.
ALTER TABLE "catalog_items"
  ADD COLUMN IF NOT EXISTS "images" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "attributes" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "brand" TEXT,
  ADD COLUMN IF NOT EXISTS "barcode" TEXT,
  ADD COLUMN IF NOT EXISTS "unit" TEXT;
