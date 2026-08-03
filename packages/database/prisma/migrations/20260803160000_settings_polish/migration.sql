-- Ajustes de /settings aprobados:
-- (1) Logo/avatar por subida: contenido binario base64 en files.content
--     (la columna NUNCA se selecciona en listados; solo el endpoint que sirve la imagen).
-- (5) Plantillas de prompt: tipo + asignación a agentes ([] = todos).

ALTER TABLE "files" ADD COLUMN "content" TEXT;

ALTER TABLE "prompt_templates" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'instructions';
ALTER TABLE "prompt_templates" ADD COLUMN "agent_ids" JSONB NOT NULL DEFAULT '[]';
