-- Grupos de contactos (colección nombrada para segmentar; distinta de las etiquetas).
CREATE TABLE "contact_groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_groups_organization_id_name_key" ON "contact_groups"("organization_id", "name");
CREATE INDEX "contact_groups_organization_id_idx" ON "contact_groups"("organization_id");

CREATE TABLE "contact_group_members" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_group_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_group_members_group_id_contact_id_key" ON "contact_group_members"("group_id", "contact_id");
CREATE INDEX "contact_group_members_organization_id_group_id_idx" ON "contact_group_members"("organization_id", "group_id");
CREATE INDEX "contact_group_members_organization_id_contact_id_idx" ON "contact_group_members"("organization_id", "contact_id");

ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "contact_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Difusiones (envíos masivos por plantilla de WhatsApp aprobada).
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_name" TEXT NOT NULL,
    "channel_connection_id" TEXT,
    "audience_type" TEXT NOT NULL,
    "audience_ref" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "broadcasts_organization_id_status_idx" ON "broadcasts"("organization_id", "status");
CREATE INDEX "broadcasts_organization_id_created_at_idx" ON "broadcasts"("organization_id", "created_at");

CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "broadcast_recipients_organization_id_broadcast_id_idx" ON "broadcast_recipients"("organization_id", "broadcast_id");
CREATE INDEX "broadcast_recipients_broadcast_id_status_idx" ON "broadcast_recipients"("broadcast_id", "status");

ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
