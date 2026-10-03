-- F9/M2 — Inmutabilidad (append-only) + RLS por tenant de las tablas de caja TAMBIÉN en una
-- migración (no solo en sql/setup.sql), para que un `prisma migrate deploy` sin el paso manual
-- `db:setup` deje la caja ya protegida. Idempotente: re-aplicable. Guardado por si las tablas
-- o el rol de la app aún no existen (dev sin setup, o despliegues parciales).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cash_ledger') THEN
    EXECUTE 'ALTER TABLE public.cash_ledger ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.cash_ledger FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.cash_ledger';
    EXECUTE 'CREATE POLICY tenant_isolation ON public.cash_ledger USING (organization_id = current_setting(''app.org_id'', true)) WITH CHECK (organization_id = current_setting(''app.org_id'', true))';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conversia_app') THEN
      EXECUTE 'GRANT SELECT, INSERT ON public.cash_ledger TO conversia_app';
      EXECUTE 'REVOKE UPDATE, DELETE ON public.cash_ledger FROM conversia_app';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cash_closures') THEN
    EXECUTE 'ALTER TABLE public.cash_closures ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.cash_closures FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON public.cash_closures';
    EXECUTE 'CREATE POLICY tenant_isolation ON public.cash_closures USING (organization_id = current_setting(''app.org_id'', true)) WITH CHECK (organization_id = current_setting(''app.org_id'', true))';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conversia_app') THEN
      EXECUTE 'GRANT SELECT, INSERT ON public.cash_closures TO conversia_app';
      EXECUTE 'REVOKE UPDATE, DELETE ON public.cash_closures FROM conversia_app';
    END IF;
  END IF;
END $$;
