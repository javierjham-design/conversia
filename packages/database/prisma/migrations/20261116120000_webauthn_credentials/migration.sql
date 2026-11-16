-- P1 — PASSKEYS: las llaves públicas de los aparatos con los que se entra con Face ID,
-- huella o Windows Hello.
--
-- Lo que se guarda es una llave PÚBLICA. La privada nunca sale del chip seguro del equipo y
-- la biometría solo la destraba, así que esta tabla no contiene ningún dato biométrico.
--
-- SIN `organization_id`, a propósito y por dos razones: la credencial es del USUARIO (que
-- puede operar varias organizaciones) y `sql/setup.sql` pone RLS sobre TODA tabla que tenga
-- esa columna — esta hay que poder leerla ANTES de saber a qué organización entra la persona.
--
-- Aditiva: crea una tabla nueva y no toca ninguna existente. El código viejo que esté
-- corriendo la ignora por completo.
CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "rp_id" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" JSONB NOT NULL DEFAULT '[]',
    "device_type" TEXT,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- La misma credencial no puede quedar inscrita dos veces, ni repartida en dos cuentas.
CREATE UNIQUE INDEX IF NOT EXISTS "webauthn_credentials_credential_id_key"
  ON "webauthn_credentials"("credential_id");

-- Las dos consultas que existen son "las credenciales de este usuario en esta marca":
-- al ofrecerlas para entrar y al listar los aparatos en Ajustes.
CREATE INDEX IF NOT EXISTS "webauthn_credentials_user_id_rp_id_idx"
  ON "webauthn_credentials"("user_id", "rp_id");

-- FK en bloque idempotente: `ADD CONSTRAINT` no admite `IF NOT EXISTS` en ninguna versión de
-- Postgres, y sin esto una aplicación parcial de esta migración dejaría el archivo imposible
-- de volver a correr. Borrar al usuario se lleva sus passkeys (no sirven sin él).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webauthn_credentials_user_id_fkey'
  ) THEN
    ALTER TABLE "webauthn_credentials"
      ADD CONSTRAINT "webauthn_credentials_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
