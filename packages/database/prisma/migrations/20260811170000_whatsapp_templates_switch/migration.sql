-- Interruptor de MENSAJES DE PLANTILLA de WhatsApp: capacidad por plan + switch por tenant.
-- Migración de DATOS (no cambia el esquema; todo vive en JSON: plans.features y
-- organizations.settings). Aditiva y reversible (rollback manual al final).

-- 1) Capacidad por PLAN (features.whatsappTemplates). Los planes básicos (Free) NO
--    incluyen plantillas, independiente del switch por-tenant; los de pago sí.
--    Configurable después desde el Super Admin (PATCH /platform/plans/:id/features).
UPDATE "plans"
   SET "features" = jsonb_set(COALESCE("features", '{}'::jsonb), '{whatsappTemplates}', 'true'::jsonb, true)
 WHERE "code" IN ('starter', 'pro', 'enterprise');

UPDATE "plans"
   SET "features" = jsonb_set(COALESCE("features", '{}'::jsonb), '{whatsappTemplates}', 'false'::jsonb, true)
 WHERE "code" = 'free';

-- 2) Interruptor por TENANT (settings.messaging.templatesEnabled). APAGADO por
--    defecto en tenants nuevos (no se toca a quien no usa plantillas). CRÍTICO:
--    los tenants que HOY usan plantillas deben quedar ENCENDIDOS para no cortar
--    recordatorios en silencio (p. ej. Digital Dent). Se encienden las orgs (no
--    borradas) con plantillas sincronizadas o con envíos de plantilla registrados.
UPDATE "organizations" o
   SET "settings" = jsonb_set(
         jsonb_set(COALESCE(o."settings", '{}'::jsonb), '{messaging}', COALESCE(o."settings" -> 'messaging', '{}'::jsonb), true),
         '{messaging,templatesEnabled}', 'true'::jsonb, true)
 WHERE o."deleted_at" IS NULL
   AND (
     EXISTS (SELECT 1 FROM "whatsapp_templates" wt WHERE wt."organization_id" = o."id")
     OR EXISTS (SELECT 1 FROM "usage_events" ue WHERE ue."organization_id" = o."id" AND ue."type" = 'whatsapp_message')
   );

-- Rollback (manual, NO automático):
--   UPDATE "plans" SET "features" = "features" - 'whatsappTemplates';
--   UPDATE "organizations" SET "settings" = "settings" #- '{messaging,templatesEnabled}';
