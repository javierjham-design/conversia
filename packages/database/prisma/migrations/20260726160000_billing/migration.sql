-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');
-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "interval" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "is_public" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "price_clp" DECIMAL(12,0) NOT NULL DEFAULT 0,
ADD COLUMN     "trial_days" INTEGER NOT NULL DEFAULT 0;
-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "amount_due" DECIMAL(12,2) NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "provider_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "kind" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "provider_ref" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "invoices_organization_id_status_idx" ON "invoices"("organization_id", "status");
-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_number_key" ON "invoices"("organization_id", "number");
-- CreateIndex
CREATE INDEX "payment_methods_organization_id_idx" ON "payment_methods"("organization_id");
