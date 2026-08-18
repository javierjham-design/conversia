-- Cobro recurrente de suscripciones (agnóstico de pasarela). Aditivo.
-- Nuevo estado de suscripción.
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';

-- Campos de cobro recurrente en la suscripción.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "provider_customer_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_subscription_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "payment_method_id" TEXT,
  ADD COLUMN IF NOT EXISTS "next_charge_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "past_due_since" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retries_done" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "subscriptions_status_next_charge_at_idx"
  ON "subscriptions" ("status", "next_charge_at");

-- Registro de intentos de cobro (idempotente por commerce_order).
CREATE TABLE IF NOT EXISTS "payment_attempts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "commerce_order" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CLP',
  "kind" TEXT NOT NULL,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "provider" TEXT NOT NULL,
  "provider_ref" TEXT,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_attempts_commerce_order_key" ON "payment_attempts" ("commerce_order");
CREATE INDEX IF NOT EXISTS "payment_attempts_organization_id_idx" ON "payment_attempts" ("organization_id");
CREATE INDEX IF NOT EXISTS "payment_attempts_subscription_id_created_at_idx" ON "payment_attempts" ("subscription_id", "created_at");
