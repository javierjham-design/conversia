-- Pagos recibidos de clientes del tenant (cobros del bot vía Flow con la cuenta del tenant).
CREATE TABLE "customer_payments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "flow_token" TEXT,
    "commerce_order" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_payments_commerce_order_key" ON "customer_payments"("commerce_order");
CREATE INDEX "customer_payments_organization_id_status_idx" ON "customer_payments"("organization_id", "status");
CREATE INDEX "customer_payments_organization_id_created_at_idx" ON "customer_payments"("organization_id", "created_at");
