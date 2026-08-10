-- Bolsa de mensajes prepagada (docs/PREPAID_WALLET_DESIGN.md)

-- CreateTable
CREATE TABLE "message_wallets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "included_per_period" INTEGER NOT NULL DEFAULT 0,
    "carryover_cap" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "category" TEXT,
    "cost_usd" DECIMAL(12,6),
    "ref_type" TEXT,
    "ref_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_packages" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "price_clp" INTEGER NOT NULL,
    "price_usd" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "message_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_wallets_organization_id_key" ON "message_wallets"("organization_id");
CREATE UNIQUE INDEX "message_packages_code_key" ON "message_packages"("code");
CREATE INDEX "wallet_ledger_organization_id_created_at_idx" ON "wallet_ledger"("organization_id", "created_at");
CREATE INDEX "wallet_ledger_organization_id_ref_type_ref_id_idx" ON "wallet_ledger"("organization_id", "ref_type", "ref_id");

-- Seed de paquetes recomendados (editables desde el Super Admin).
INSERT INTO "message_packages" ("id", "code", "name", "credits", "price_clp", "price_usd", "active", "order") VALUES
  ('pkg_1k', 'msgs_1000', '1.000 mensajes', 1000, 29900, 34.00, true, 1),
  ('pkg_5k', 'msgs_5000', '5.000 mensajes', 5000, 129900, 149.00, true, 2);

-- Rollback:
-- DROP TABLE "wallet_ledger"; DROP TABLE "message_wallets"; DROP TABLE "message_packages";
