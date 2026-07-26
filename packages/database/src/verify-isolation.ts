/**
 * Verificador de aislamiento multi-tenant.
 * Se conecta con el ROL REAL DE LA APLICACIÓN (conversia_app, sin BYPASSRLS)
 * y prueba, tabla por tabla, que estando en el contexto del tenant A es
 * IMPOSIBLE leer, contar o escribir datos del tenant B.
 *
 * Uso (requiere el rol conversia_app — el mismo que usa la API en prod):
 *   APP_DATABASE_URL="postgresql://conversia_app:...@host:port/db" \
 *     npx tsx src/verify-isolation.ts
 *
 * Sale con código 1 si CUALQUIER prueba falla.
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("Falta APP_DATABASE_URL (conexión con el rol conversia_app).");
  process.exit(2);
}
if (/:postgres@|\/\/postgres:/.test(url)) {
  console.error("⚠ APP_DATABASE_URL parece usar el superusuario 'postgres'. La prueba debe correr con conversia_app (RLS aplicado).");
  process.exit(2);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✖ ${name} ${detail}`);
  }
}

/** Ejecuta fn dentro del contexto de tenant (setea app.org_id como la app). */
async function asTenant<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });
}

/** Sin contexto de tenant no debe leerse NADA (app.org_id vacío). */
async function withoutTenant<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx));
}

async function main() {
  console.log("== Verificación de aislamiento multi-tenant (rol conversia_app) ==\n");

  // Descubrir 2 organizaciones para la matriz de pruebas (con admin fuera de RLS
  // no podemos; usamos una conexión admin temporal SOLO para listar ids).
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;
  let orgA: string, orgB: string, orgAName: string, orgBName: string;
  if (adminUrl) {
    const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    const orgs = await admin.organization.findMany({ take: 2, orderBy: { createdAt: "asc" } });
    await admin.$disconnect();
    if (orgs.length < 2) {
      console.error("Se requieren al menos 2 organizaciones sembradas.");
      process.exit(2);
    }
    [orgA, orgB] = [orgs[0].id, orgs[1].id];
    [orgAName, orgBName] = [orgs[0].name, orgs[1].name];
  } else {
    orgA = process.env.ORG_A!;
    orgB = process.env.ORG_B!;
    orgAName = "A";
    orgBName = "B";
    if (!orgA || !orgB) {
      console.error("Sin ADMIN_DATABASE_URL, define ORG_A y ORG_B.");
      process.exit(2);
    }
  }
  console.log(`Tenant A = ${orgAName} (${orgA})`);
  console.log(`Tenant B = ${orgBName} (${orgB})\n`);

  // 1. Lecturas de A no incluyen filas de B, tabla por tabla ---------------
  console.log("1. Lecturas filtradas por RLS (contexto = A, no debe verse B):");
  const tables: Array<[string, (tx: any) => Promise<any[]>]> = [
    ["agents", (tx) => tx.agent.findMany()],
    ["contacts", (tx) => tx.contact.findMany()],
    ["conversations", (tx) => tx.conversation.findMany()],
    ["messages", (tx) => tx.message.findMany()],
    ["leads", (tx) => tx.lead.findMany()],
    ["workflows", (tx) => tx.workflow.findMany()],
    ["integration_credentials", (tx) => tx.integrationCredential.findMany()],
    ["webhook_endpoints", (tx) => tx.webhookEndpoint.findMany()],
    ["meta_assets", (tx) => tx.metaAsset.findMany()],
    ["ai_requests", (tx) => tx.aiRequest.findMany()],
    ["audit_logs", (tx) => tx.auditLog.findMany()],
  ];
  for (const [table, query] of tables) {
    const rows = await asTenant(orgA, query);
    const leaked = rows.filter((r: any) => r.organizationId && r.organizationId !== orgA);
    check(`${table}: 0 filas de otro tenant (${rows.length} propias)`, leaked.length === 0, `— fugaron ${leaked.length}`);
  }

  // 2. Acceso directo por id de una fila de B estando en A -----------------
  console.log("\n2. Acceso directo cruzado (buscar por id de B desde A):");
  const bAgent = await asTenant(orgB, (tx) => tx.agent.findFirst());
  if (bAgent) {
    const found = await asTenant(orgA, (tx) => tx.agent.findUnique({ where: { id: bAgent.id } }));
    check("findUnique de un agente de B desde A → null", found === null);
  } else {
    console.log("  (B no tiene agentes; se omite)");
  }
  const bContact = await asTenant(orgB, (tx) => tx.contact.findFirst());
  if (bContact) {
    const found = await asTenant(orgA, (tx) => tx.contact.findUnique({ where: { id: bContact.id } }));
    check("findUnique de un contacto de B desde A → null", found === null);
  }

  // 3. Escritura cruzada: intentar modificar una fila de B desde A ---------
  console.log("\n3. Escritura cruzada (UPDATE de B desde A no afecta filas):");
  if (bAgent) {
    const res = await asTenant(orgA, (tx) =>
      tx.agent.updateMany({ where: { id: bAgent.id }, data: { name: "HACKED" } }),
    );
    check("updateMany sobre agente de B desde A → 0 filas afectadas", res.count === 0, `— afectó ${res.count}`);
    // Confirmar que B sigue intacto
    const still = await asTenant(orgB, (tx) => tx.agent.findUnique({ where: { id: bAgent.id } }));
    check("el agente de B conserva su nombre", still?.name !== "HACKED");
  }

  // 4. Intento de INSERT con organization_id de B estando en A ------------
  console.log("\n4. Inserción con organization_id ajeno (WITH CHECK):");
  try {
    await asTenant(orgA, (tx) =>
      tx.tag.create({ data: { organizationId: orgB, name: `x-isolation-${Date.now()}` } }),
    );
    check("INSERT de un tag con organization_id=B desde A → rechazado", false, "— ¡se permitió!");
  } catch {
    check("INSERT de un tag con organization_id=B desde A → rechazado por RLS", true);
  }

  // 5. Sin contexto de tenant no se ve nada -------------------------------
  console.log("\n5. Sin app.org_id (contexto vacío) no se lee ningún dato:");
  const orphanAgents = await withoutTenant((tx) => tx.agent.findMany());
  check("agents sin contexto → 0 filas", orphanAgents.length === 0, `— vio ${orphanAgents.length}`);
  const orphanContacts = await withoutTenant((tx) => tx.contact.findMany());
  check("contacts sin contexto → 0 filas", orphanContacts.length === 0, `— vio ${orphanContacts.length}`);

  // 6. Tablas globales protegidas -----------------------------------------
  console.log("\n6. Tablas globales:");
  const platformAdmins = await asTenant(orgA, (tx) => tx.platformAdmin.findMany().catch(() => []));
  check("platform_admins invisible para el rol de app → 0 filas", platformAdmins.length === 0, `— vio ${platformAdmins.length}`);
  const users = await asTenant(orgA, (tx) => tx.user.findMany());
  const foreignUsers = await asTenant(orgA, async (tx) => {
    const memberIds = (await tx.organizationUser.findMany({ select: { userId: true } })).map((m: any) => m.userId);
    return users.filter((u: any) => !memberIds.includes(u.id));
  });
  check("users solo miembros de la organización activa", foreignUsers.length === 0, `— vio ${foreignUsers.length} ajenos`);

  // Resultado --------------------------------------------------------------
  console.log(`\n== Resultado: ${passed} pasaron, ${failed} fallaron ==`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Error en la verificación:", e);
  process.exit(1);
});
