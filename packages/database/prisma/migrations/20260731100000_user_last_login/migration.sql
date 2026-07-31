-- Última conexión del usuario (se actualiza en cada login exitoso)
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);
