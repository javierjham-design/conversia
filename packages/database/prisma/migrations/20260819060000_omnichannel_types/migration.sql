-- Omnicanal: Instagram Direct + Facebook Messenger como tipos de canal.
-- Aditivo puro (ALTER TYPE ADD VALUE no toca datos existentes).
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'INSTAGRAM';
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'MESSENGER';
