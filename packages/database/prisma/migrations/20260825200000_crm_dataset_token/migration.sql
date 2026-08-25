-- Token de acceso PROPIO del dataset del CRM (lo genera el asistente de Events
-- Manager, paso «Crear punto de conexión»). Referencia a integration_credentials
-- donde se guarda cifrado. Aditiva y reversible.
-- Rollback: ALTER TABLE "meta_event_mappings" DROP COLUMN "crm_dataset_credential_id";
ALTER TABLE "meta_event_mappings" ADD COLUMN "crm_dataset_credential_id" TEXT;
