-- Ajustes globales de plataforma (clave-valor; secretos cifrados). Aditivo.
-- Rollback: DROP TABLE "platform_settings";

CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);
