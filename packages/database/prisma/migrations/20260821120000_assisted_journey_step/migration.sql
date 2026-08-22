-- Paso del viaje de implementación PERSISTIDO en el grant de montaje asistido, para
-- que el agente sepa siempre en qué paso va cada cliente (antes se INFERÍA de la
-- conversación → re-derivaba/re-preguntaba). Aditivo e idempotente.
ALTER TABLE "assisted_setup_grants"
  ADD COLUMN IF NOT EXISTS "journey_step" INTEGER,
  ADD COLUMN IF NOT EXISTS "journey_label" TEXT,
  ADD COLUMN IF NOT EXISTS "journey_updated_at" TIMESTAMP(3);
