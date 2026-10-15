-- V2-5 copiloto — nuevo estado de mensaje SUGGESTED (borrador del bot pendiente de aprobación).
-- Aditivo (ALTER TYPE ADD VALUE). Compatible hacia atrás. No hay reversa simple de un enum value
-- en Postgres (quedaría sin uso si se revierte el código).
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'SUGGESTED';
