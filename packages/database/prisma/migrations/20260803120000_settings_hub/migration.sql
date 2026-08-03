-- Centro de Configuración del tenant (aprobado en auditoría):
-- etapas activables, ámbito de snippets, campos de contacto ordenables,
-- exports en background y biblioteca de plantillas de prompt.

ALTER TABLE "lead_statuses" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "snippets" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'team';

ALTER TABLE "custom_field_definitions" ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "custom_field_definitions" ADD COLUMN "show_in_list" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "content" TEXT,
    "rows" INTEGER,
    "error" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "export_jobs_organization_id_created_at_idx" ON "export_jobs"("organization_id", "created_at");

CREATE TABLE "prompt_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prompt_templates_organization_id_name_key" ON "prompt_templates"("organization_id", "name");
CREATE INDEX "prompt_templates_organization_id_idx" ON "prompt_templates"("organization_id");
