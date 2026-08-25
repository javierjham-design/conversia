-- Dataset EXCLUSIVO del CRM (embudo lead.*) separado del dataset general/WABA.
-- Aditiva y reversible. NULL = el CRM usa el mismo dataset general (compatibilidad).
-- Rollback: ALTER TABLE "meta_event_mappings" DROP COLUMN "crm_dataset_id";
ALTER TABLE "meta_event_mappings" ADD COLUMN "crm_dataset_id" TEXT;
