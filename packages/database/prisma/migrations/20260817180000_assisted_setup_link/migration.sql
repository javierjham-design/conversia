-- Ligadura conversación-de-TuBot ↔ org-cliente para el montaje asistido: el enlace
-- de un clic guarda a qué contacto de TuBot corresponde el grant, para que los tools
-- del agente de implementación resuelvan el org-cliente desde la conversación.
ALTER TABLE "assisted_setup_grants" ADD COLUMN "linked_provider_contact_id" TEXT;

CREATE INDEX "assisted_setup_grants_linked_provider_contact_id_idx"
  ON "assisted_setup_grants"("granted_by_organization_id", "linked_provider_contact_id", "status");
