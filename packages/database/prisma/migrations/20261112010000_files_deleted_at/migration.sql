-- D4 — RETENCIÓN DE MEDIOS GUARDADOS.
--
-- `files` no tenía forma de marcar un archivo como vencido. El trabajo diario de retención
-- borra el objeto del bucket y marca la fila: la fila SE CONSERVA a propósito, porque el
-- mensaje sigue existiendo en el chat y el panel tiene que poder decir "este archivo ya no
-- está disponible" en vez de mostrar un hueco sin explicación.
--
-- Aditiva y sin valor por defecto: ninguna fila existente cambia y nada deja de funcionar si
-- el código viejo todavía está corriendo.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- El barrido busca "lo guardado hace más de N días y todavía no borrado". Sin índice, ese
-- barrido lee la tabla entera cada noche.
CREATE INDEX IF NOT EXISTS "files_scope_created_at_idx"
  ON "files" ("scope", "created_at")
  WHERE "deleted_at" IS NULL;
