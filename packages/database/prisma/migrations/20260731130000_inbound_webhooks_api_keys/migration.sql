-- Webhooks entrantes por tenant (URL pública /hooks/t/{token} → trigger de workflows)
CREATE TABLE "inbound_webhooks" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "secret_ciphertext" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "last_received_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbound_webhooks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inbound_webhooks_token_key" ON "inbound_webhooks"("token");
CREATE INDEX "inbound_webhooks_organization_id_idx" ON "inbound_webhooks"("organization_id");

-- API keys por tenant (API pública de Conversia; solo el hash en reposo)
CREATE TABLE "api_keys" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '[]',
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

-- Rollback:
--   DROP TABLE "api_keys";
--   DROP TABLE "inbound_webhooks";
