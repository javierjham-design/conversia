/**
 * Guard de COBERTURA de RLS (estático, contra el catálogo de Postgres).
 * A diferencia de verify-isolation (que prueba el comportamiento con datos sembrados),
 * este chequea que la POLÍTICA existe en TODA tabla de tenant — así, si mañana alguien
 * agrega una tabla con `organization_id` y olvida la RLS, el CI falla.
 *
 * Regla: toda BASE TABLE de `public` con columna `organization_id` debe tener
 * RLS habilitado + FORCE + política `tenant_isolation`. Además valida las tablas
 * globales protegidas (organizations, users, platform_admins).
 *
 * Uso: DATABASE_URL=... (admin/superusuario) npx tsx src/verify-rls-coverage.ts
 * Sale 1 si falta cobertura en alguna tabla.
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL/ADMIN_DATABASE_URL.");
  process.exit(2);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

interface TableRls {
  relname: string;
  rls: boolean;
  force: boolean;
  has_policy: boolean;
}

async function main() {
  console.log("== Cobertura de RLS sobre tablas de tenant (catálogo) ==\n");
  let failed = 0;

  // Toda tabla base de public con columna organization_id.
  const rows = await prisma.$queryRawUnsafe<TableRls[]>(`
    SELECT c.relname,
           c.relrowsecurity      AS rls,
           c.relforcerowsecurity  AS force,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS has_policy
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'organization_id'
      )
    ORDER BY c.relname
  `);

  console.log(`Tablas de tenant detectadas: ${rows.length}\n`);
  for (const t of rows) {
    const ok = t.rls && t.force && t.has_policy;
    if (!ok) {
      failed++;
      const missing = [!t.rls && "RLS", !t.force && "FORCE", !t.has_policy && "política tenant_isolation"].filter(Boolean).join(", ");
      console.log(`  ✖ ${t.relname} — falta: ${missing}`);
    }
  }
  if (failed === 0) console.log(`  ✔ Las ${rows.length} tablas de tenant tienen RLS + FORCE + política.`);

  // Tablas globales protegidas: verificar que tienen RLS habilitado (aislamiento en capa app).
  console.log("\nTablas globales:");
  const globals = await prisma.$queryRawUnsafe<{ relname: string; rls: boolean; npol: number }[]>(`
    SELECT c.relname, c.relrowsecurity AS rls,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS npol
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('organizations','users','platform_admins','plans')
  `);
  const byName = new Map(globals.map((g) => [g.relname, g]));
  for (const name of ["organizations", "users", "platform_admins", "plans"]) {
    const g = byName.get(name);
    if (!g) { console.log(`  ⚠ ${name} no encontrada (¿modelo distinto?)`); continue; }
    if (!g.rls) { failed++; console.log(`  ✖ ${name} — RLS deshabilitado`); continue; }
    // platform_admins debe ser deny-all (RLS on, 0 políticas para roles no-bypass).
    if (name === "platform_admins" && g.npol > 0) { failed++; console.log(`  ✖ platform_admins tiene ${g.npol} política(s); debe ser deny-all (0)`); continue; }
    console.log(`  ✔ ${name} (RLS on, ${g.npol} política(s))`);
  }

  console.log(`\n== Resultado: ${failed === 0 ? "cobertura COMPLETA" : `${failed} problema(s)`} ==`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Error en el guard de cobertura:", e);
  process.exit(1);
});
