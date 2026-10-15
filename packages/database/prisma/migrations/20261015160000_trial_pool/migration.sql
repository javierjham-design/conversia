-- V2-4 — "Pruébalo en TU WhatsApp": pool de números de prueba + vínculo teléfono↔org.
-- trial_sessions NO tiene organization_id (usa org_id_ref) para NO entrar en el RLS dinámico
-- (el pool se consulta por teléfono antes de resolver el tenant). Aditiva.
-- Reversa: DROP TABLE trial_sessions, trial_pool_numbers;

CREATE TABLE "trial_pool_numbers" (
    "id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_number" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trial_pool_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trial_pool_numbers_phone_number_id_key" ON "trial_pool_numbers"("phone_number_id");

CREATE TABLE "trial_sessions" (
    "id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "org_id_ref" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trial_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trial_sessions_phone_number_id_contact_phone_key" ON "trial_sessions"("phone_number_id", "contact_phone");
CREATE INDEX "trial_sessions_code_idx" ON "trial_sessions"("code");
