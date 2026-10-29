-- CRE — índices del libro de créditos. Aditiva: no reescribe ni borra datos.
-- Reversa: DROP INDEX "ccledger_org_reason_ref_idx", "conversation_credit_ledger_turno_unico";
--
-- 1) ÍNDICE DE LOS DEDUPES. Cada débito de un turno y cada acreditación de período
--    preguntan "¿ya existe este asiento?" filtrando por (organization_id, reason, ref_id).
--    El único índice que había era (organization_id, created_at), así que esa pregunta
--    recorría TODO el histórico de la organización — y lo hace con el cerrojo de la cuenta
--    tomado, o sea serializando los cobros detrás de un escaneo que crece cada día del mes.
--    Con un asiento por respuesta del bot, al cliente más grande se le degrada el cobro
--    justo cuando más responde.
CREATE INDEX IF NOT EXISTS "ccledger_org_reason_ref_idx"
  ON "conversation_credit_ledger" ("organization_id", "reason", "ref_id");

-- 2) UN SOLO COBRO POR TURNO, garantizado por la base.
--    La idempotencia del débito es un `findFirst` seguido de un `create`: un check-then-act
--    que el cerrojo por organización protege hoy. Este índice lo vuelve imposible de violar
--    incluso si alguna vez se cobra desde un camino que no tome el cerrojo (una migración,
--    un script del super admin, una reconciliación nueva): el segundo asiento del mismo
--    turno falla con error en vez de cobrarle dos veces al cliente.
--    Es PARCIAL —solo los asientos de turno— porque los demás comparten ref_id a propósito:
--    una compra sin referencia del proveedor cae a `ref_id = <código del pack>`, y un unique
--    general rechazaría la segunda compra legítima del mismo pack.
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_credit_ledger_turno_unico"
  ON "conversation_credit_ledger" ("organization_id", "ref_id")
  WHERE "ref_type" = 'turn';
