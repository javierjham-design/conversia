-- F7 soporte in-app: código legible (CV-XXXX) + hilo de conversación en el ticket.
-- Aditivo y seguro: columnas con default; sin tabla nueva (el hilo va en JSON → sin RLS
-- adicional). No toca el motor/worker (esa parte —IA en org proveedora + continuidad por
-- webhook— se enchufa después, con cuidado).
--
-- PLAN DE REVERSA:
--   ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "code", DROP COLUMN IF EXISTS "thread";

ALTER TABLE "support_tickets" ADD COLUMN "code" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "thread" JSONB NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX "support_tickets_code_key" ON "support_tickets" ("code");
