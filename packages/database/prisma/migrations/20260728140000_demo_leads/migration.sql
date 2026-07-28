-- CRM de prospectos/demos de la plataforma. Aditivo y reversible.
-- Rollback: DROP TABLE "demo_leads";

CREATE TABLE "demo_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT,
    "plan_interest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "organization_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "demo_leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "demo_leads_status_created_at_idx" ON "demo_leads"("status", "created_at");
