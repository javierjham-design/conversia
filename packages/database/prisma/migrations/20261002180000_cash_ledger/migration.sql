-- F9 — Recaudación y caja. Libro APPEND-ONLY e inmutable + cierres de caja.
-- La inmutabilidad real (revocar UPDATE/DELETE al rol conversia_app) y la RLS por tenant
-- las aplica sql/setup.sql (se corre tras esta migración). Montos en ENTEROS.
--
-- PLAN DE REVERSA:
--   DROP TABLE IF EXISTS "cash_closures"; DROP TABLE IF EXISTS "cash_ledger";

CREATE TABLE "cash_ledger" (
  "id"              TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "type"            TEXT NOT NULL,
  "method"          TEXT NOT NULL,
  "amount"          INTEGER NOT NULL,
  "currency"        TEXT NOT NULL DEFAULT 'CLP',
  "ref_type"        TEXT,
  "ref_id"          TEXT,
  "concept"         TEXT,
  "reversal_of"     TEXT,
  "status"          TEXT NOT NULL DEFAULT 'declarado',
  "created_by_id"   TEXT NOT NULL,
  "origin"          TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "cash_ledger_org_idem_key" ON "cash_ledger" ("organization_id", "idempotency_key");
CREATE INDEX "cash_ledger_org_created_idx" ON "cash_ledger" ("organization_id", "created_at");
CREATE INDEX "cash_ledger_org_ref_idx" ON "cash_ledger" ("organization_id", "ref_type", "ref_id");

CREATE TABLE "cash_closures" (
  "id"              TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL,
  "from_at"         TIMESTAMP(3) NOT NULL,
  "to_at"           TIMESTAMP(3) NOT NULL,
  "totals_by_method" JSONB NOT NULL,
  "conciliado"      INTEGER NOT NULL DEFAULT 0,
  "declarado"       INTEGER NOT NULL DEFAULT 0,
  "declared_cash"   INTEGER NOT NULL,
  "calculated_cash" INTEGER NOT NULL,
  "difference"      INTEGER NOT NULL,
  "closed_by_id"    TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "cash_closures_org_created_idx" ON "cash_closures" ("organization_id", "created_at");
