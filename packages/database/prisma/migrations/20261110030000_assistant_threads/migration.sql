-- B1 — HISTORIAL DE CONVI EN TABLAS PROPIAS.
--
-- Hasta ahora la conversación con el copiloto vivía SOLO en el `useState` del widget: cambiar
-- de sección (la navegación del panel usa <a href>, o sea recarga completa) borraba el hilo, y
-- el cliente no podía volver a leer lo que habían acordado. El contexto que recibía el modelo
-- lo mandaba el navegador, así que además era manipulable desde el cliente.
--
-- Por qué TABLAS y no un JSON como `support_tickets.thread`: acá hay que paginar, buscar y
-- resumir lo antiguo. Un arreglo dentro de una fila obliga a leer el hilo entero en cada turno
-- y crece sin techo.
--
-- Aditiva: no toca ninguna tabla existente. Reversa:
--   DROP TABLE "assistant_messages"; DROP TABLE "assistant_threads";
--
-- RLS: `sql/setup.sql` la aplica SOLA a toda tabla con `organization_id` (y agrega la FK a
-- organizations), así que hay que correrlo después de migrar — el job `tenant-isolation` de CI
-- lo comprueba barriendo todas las tablas con esa columna.

CREATE TABLE IF NOT EXISTS "assistant_threads" (
  "id"              TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "user_id"         TEXT NOT NULL,
  "title"           TEXT,
  "summary"         TEXT,
  "status"          TEXT NOT NULL DEFAULT 'open',
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- La lista del historial: los hilos de un usuario, del más reciente al más viejo.
CREATE INDEX IF NOT EXISTS "assistant_threads_org_user_last_idx"
  ON "assistant_threads" ("organization_id", "user_id", "last_message_at");

-- UN SOLO HILO ABIERTO POR USUARIO, garantizado por la base.
--
-- El servidor elige el hilo con un "busca el abierto, si no créalo": un check-then-act que dos
-- pestañas del mismo dueño pueden ganar a la vez. Sin esto quedarían dos hilos abiertos y los
-- mensajes se repartirían entre ambos — el dueño vería su conversación partida en dos sin
-- entender por qué. Es PARCIAL porque los archivados sí pueden ser muchos.
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_threads_uno_abierto_por_usuario"
  ON "assistant_threads" ("organization_id", "user_id")
  WHERE "status" = 'open';

CREATE TABLE IF NOT EXISTS "assistant_messages" (
  "id"              TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "thread_id"       TEXT NOT NULL,
  "role"            TEXT NOT NULL,
  "content"         TEXT NOT NULL,
  "actions"         JSONB,
  -- Solo metadatos del adjunto (tipo y nombre). El archivo no se guarda acá.
  "adjuntos"        JSONB,
  "route"           TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Leer un hilo en orden cronológico (y paginar por cursor).
CREATE INDEX IF NOT EXISTS "assistant_messages_thread_created_idx"
  ON "assistant_messages" ("thread_id", "created_at");
CREATE INDEX IF NOT EXISTS "assistant_messages_org_idx"
  ON "assistant_messages" ("organization_id");

-- Borrar el hilo se lleva sus mensajes: no quedan mensajes huérfanos de un hilo que ya no existe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assistant_messages_thread_id_fkey') THEN
    ALTER TABLE "assistant_messages"
      ADD CONSTRAINT "assistant_messages_thread_id_fkey"
      FOREIGN KEY ("thread_id") REFERENCES "assistant_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
