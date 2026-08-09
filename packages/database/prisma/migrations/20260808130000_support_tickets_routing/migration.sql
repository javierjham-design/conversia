-- Campos para enrutar tickets a la futura bandeja de TuBot (tenant de sí mismo).
-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN "contact_id" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "routed_conversation_id" TEXT;

-- Rollback:
-- ALTER TABLE "support_tickets" DROP COLUMN "contact_id";
-- ALTER TABLE "support_tickets" DROP COLUMN "routed_conversation_id";
