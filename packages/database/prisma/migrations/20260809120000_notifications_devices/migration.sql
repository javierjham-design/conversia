-- CreateTable: dispositivos de push (genérica web/ios/android/desktop)
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "keys" JSONB NOT NULL DEFAULT '{}',
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable: registro de entregas de notificaciones (log para soporte)
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "device_id" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_user_id_identifier_key" ON "push_devices"("user_id", "identifier");
CREATE INDEX "push_devices_organization_id_user_id_active_idx" ON "push_devices"("organization_id", "user_id", "active");
CREATE INDEX "notification_deliveries_organization_id_created_at_idx" ON "notification_deliveries"("organization_id", "created_at");
CREATE INDEX "notification_deliveries_organization_id_user_id_created_at_idx" ON "notification_deliveries"("organization_id", "user_id", "created_at");

-- Rollback:
-- DROP TABLE "notification_deliveries";
-- DROP TABLE "push_devices";
