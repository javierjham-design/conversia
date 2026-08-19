-- Unificación: copia los SERVICIOS manuales activos al catálogo (source='manual',
-- kind='service', enlazados por service_id). Idempotente (WHERE NOT EXISTS) y NO borra
-- ni toca `services` (que sigue rigiendo la agenda: duración, profesionales, sedes).
-- El agente pasa a encontrar los servicios vía el catálogo unificado (buscarProductos).
INSERT INTO "catalog_items" (
  "id", "organization_id", "source", "external_id", "kind", "sku", "name", "description",
  "category", "price", "currency", "available", "active", "service_id", "synced_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text, s."organization_id", 'manual', s."id", 'service', s."code", s."name", s."description",
  s."category", s."price", s."currency", true, s."active", s."id", now(), now(), now()
FROM "services" s
WHERE s."active" = true
  AND NOT EXISTS (
    SELECT 1 FROM "catalog_items" ci
    WHERE ci."organization_id" = s."organization_id" AND ci."source" = 'manual' AND ci."external_id" = s."id"
  );
