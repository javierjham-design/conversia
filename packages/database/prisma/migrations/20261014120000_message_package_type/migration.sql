-- V2-0 — tipo de pack en message_packages: "message" (sobres legacy) | "conversation" (packs V2).
-- Aditiva y compatible hacia atrás (default "message" = comportamiento actual de todos los sobres).
ALTER TABLE "message_packages" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'message';

-- Reversa:
-- ALTER TABLE "message_packages" DROP COLUMN "type";
