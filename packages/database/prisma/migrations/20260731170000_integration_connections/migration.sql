-- La tabla integration_connections existe desde el schema inicial (sin uso).
-- Se agrega la unicidad org+provider (una conexión por integración) y el
-- proveedor CUSTOM del contrato estándar de agenda.
CREATE UNIQUE INDEX "integration_connections_organization_id_provider_key" ON "integration_connections"("organization_id", "provider");

ALTER TYPE "SchedulingProviderKind" ADD VALUE IF NOT EXISTS 'CUSTOM';

-- Rollback:
--   DROP INDEX "integration_connections_organization_id_provider_key";
--   (el valor de enum CUSTOM no se elimina: Postgres no permite quitar valores
--    de enum sin recrear el tipo; es inocuo si no se usa)
