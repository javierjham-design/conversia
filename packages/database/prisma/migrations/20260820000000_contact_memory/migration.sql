-- Memoria compartida por contacto ("ficha viva"): hechos que cualquier agente
-- anota y que se inyectan en el prompt de todos los agentes, en cualquier
-- conversación. La RLS (tenant_isolation) y la FK a organizations las agrega
-- db:setup dinámicamente por tener columna organization_id; el índice vectorial
-- HNSW también se crea en db:setup (sql/setup.sql). Aditivo e idempotente.
CREATE TABLE IF NOT EXISTS "contact_memories" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'other',
  "content" TEXT NOT NULL,
  "agent_id" TEXT,
  "source_conversation_id" TEXT,
  "embedding" vector(1536),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "contact_memories_org_contact_idx"
  ON "contact_memories" ("organization_id", "contact_id");

-- FK al contacto (cascade): si se borra el contacto, se borra su memoria.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_memories_contact_fk'
  ) THEN
    ALTER TABLE "contact_memories"
      ADD CONSTRAINT "contact_memories_contact_fk"
      FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
