-- V2-1 — bolsa de CONVERSACIONES (crédito-conversación), separada de message_wallets.
-- Aditiva (3 tablas nuevas). RLS + FK los aplica sql/setup.sql (dinámico por organization_id).
-- Reversa: DROP TABLE conversation_credit_ledger, conversation_wallets, conversation_credit_lots;

CREATE TABLE "conversation_credit_lots" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3),
    "ref_type" TEXT,
    "ref_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_credit_lots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cclots_org_remaining_expires_idx" ON "conversation_credit_lots"("organization_id", "remaining", "expires_at");

CREATE TABLE "conversation_wallets" (
    "organization_id" TEXT NOT NULL,
    "grace_used" INTEGER NOT NULL DEFAULT 0,
    "last_notified_pct" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_wallets_pkey" PRIMARY KEY ("organization_id")
);

CREATE TABLE "conversation_credit_ledger" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "cost_usd" DECIMAL(12,6),
    "conversation_id" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_credit_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ccledger_org_created_idx" ON "conversation_credit_ledger"("organization_id", "created_at");
