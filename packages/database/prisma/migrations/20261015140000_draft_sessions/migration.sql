-- V2-3 — draft efímero del generador público (/crear). SIN organization_id (vive antes de
-- la cuenta) → NO entra en RLS. Aditiva. Reversa: DROP TABLE draft_sessions;
CREATE TABLE "draft_sessions" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "website" TEXT,
    "scrape" JSONB,
    "config" JSONB NOT NULL DEFAULT '{}',
    "messages_used" INTEGER NOT NULL DEFAULT 0,
    "ip_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "materialized_org_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "draft_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "draft_sessions_token_key" ON "draft_sessions"("token");
CREATE INDEX "draft_sessions_expires_at_idx" ON "draft_sessions"("expires_at");
