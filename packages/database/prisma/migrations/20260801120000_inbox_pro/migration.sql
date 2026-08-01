-- Bandeja Pro: bandejas personalizadas, respuestas rápidas e indicaciones a la IA
-- (aditiva; RLS se aplica con sql/setup.sql — las 3 tablas tienen organization_id)

CREATE TABLE "inbox_views" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbox_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbox_views_organization_id_name_key" ON "inbox_views"("organization_id", "name");
CREATE INDEX "inbox_views_organization_id_idx" ON "inbox_views"("organization_id");

CREATE TABLE "snippets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "snippets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "snippets_organization_id_shortcut_key" ON "snippets"("organization_id", "shortcut");
CREATE INDEX "snippets_organization_id_idx" ON "snippets"("organization_id");

CREATE TABLE "conversation_ai_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMP(3),

    CONSTRAINT "conversation_ai_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_ai_notes_organization_id_conversation_id_active_idx" ON "conversation_ai_notes"("organization_id", "conversation_id", "active");

-- Índices para los conteos del clasificador (por agente IA / por equipo)
CREATE INDEX "conversations_organization_id_active_agent_id_idx" ON "conversations"("organization_id", "active_agent_id");
CREATE INDEX "conversations_organization_id_assigned_team_id_idx" ON "conversations"("organization_id", "assigned_team_id");
