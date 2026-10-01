-- E3 — Cupo de conversaciones por período (plan servicio-octubre-2026).
-- ADITIVA: ningún código previo lee estas tablas; service_send y usage_events
-- quedan inertes si se revierte.
--
-- PLAN DE REVERSA:
--   DROP TABLE IF EXISTS "conversation_quota_marks";
--   DROP TABLE IF EXISTS "conversation_quota_counters";
--   DROP INDEX IF EXISTS "usage_events_ext_idx";
--   + redeploy del código anterior.

-- Marca de "esta conversación ya contó este período" (idempotencia entre workers).
CREATE TABLE "conversation_quota_marks" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_quota_marks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_quota_marks_organization_id_conversation_id_per_key"
    ON "conversation_quota_marks" ("organization_id", "conversation_id", "period_start");

CREATE INDEX "conversation_quota_marks_organization_id_period_start_idx"
    ON "conversation_quota_marks" ("organization_id", "period_start");

-- Agregado atómico por (organización, período).
CREATE TABLE "conversation_quota_counters" (
    "organization_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "overage" INTEGER NOT NULL DEFAULT 0,
    "included" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_quota_counters_pkey" PRIMARY KEY ("organization_id", "period_start")
);

-- Dedupe del webhook de statuses por externalId (hoy escanea). Índice de expresión
-- (Prisma no lo modela). En prod con tabla grande, el runbook lo aplica con
-- CREATE INDEX CONCURRENTLY fuera de la transacción.
CREATE INDEX "usage_events_ext_idx"
    ON "usage_events" ("organization_id", "type", (("meta"->>'externalId')));
