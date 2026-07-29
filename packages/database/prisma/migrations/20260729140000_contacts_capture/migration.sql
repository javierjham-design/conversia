-- Módulo de Contactos: captura máxima de datos de Meta/WhatsApp + segmentos.
-- Aditivo y seguro (solo ADD COLUMN con default / CREATE TABLE).

-- AlterTable: nuevos campos del contacto (perfil separado del nombre real,
-- país, fuente de creación, atribución de anuncios y payload crudo de Meta).
ALTER TABLE "contacts" ADD COLUMN     "acquisition_source" TEXT,
ADD COLUMN     "ad_id" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "created_via" TEXT NOT NULL DEFAULT 'webhook',
ADD COLUMN     "ctwa_clid" TEXT,
ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "profile_name" TEXT;

-- CreateTable: segmentos (filtros guardados por tenant)
CREATE TABLE "contact_segments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_segments_organization_id_idx" ON "contact_segments"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_segments_organization_id_name_key" ON "contact_segments"("organization_id", "name");

-- CreateIndex
CREATE INDEX "contacts_organization_id_created_at_idx" ON "contacts"("organization_id", "created_at");
