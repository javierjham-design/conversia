/**
 * RETIRAR LOS PLANES VIEJOS DE CONVERSIA y dejar el catálogo en lo que se vende hoy.
 *
 * Decisión del dueño, 11-nov-2026: la oferta de Conversia queda en **Prueba + Base** (los
 * planes de créditos) más **Custom** para lo que se arma a mano. Se retiran cuatro:
 *
 *   conversia_v2_trial     «Prueba» del modelo por conversación  (duplicaba el nombre)
 *   conversia_v2_base      «Base» a $18.900                      (precio obsoleto)
 *   conversia_funcionando  «Funcionando» a $149.900              (servicio administrado)
 *   conversia_gestionado   «Gestionado» a $299.900               (servicio administrado)
 *
 * Por qué un script y no el seeder: el seeder se niega a apagar un plan que ya está vivo
 * —salvaguarda correcta para algo que se corre muchas veces— así que retirar en un entorno
 * que ya los tiene vivos es una operación explícita, que se mira antes de aplicar y queda en
 * la bitácora.
 *
 * ORDEN OBLIGATORIO, y por eso va todo en una transacción: primero se MUEVEN las
 * suscripciones, después se apagan los planes. Al revés deja tenants apuntando a un plan
 * inactivo, que es justo el estado en el que estaban tres cuentas (plan desactivado y
 * suscripción encima) y por el que los límites quedan sin resolver.
 *
 * NO toca precios de nada que siga vivo, no borra ninguna fila y no toca otra marca que
 * `conversia`. Las suscripciones se mueven de plan conservando su período y su estado.
 *
 * Uso (desde packages/database, con la base de prod):
 *   railway run --service Postgres -- node scripts/retirar-planes-conversia.mjs
 *   railway run --service Postgres -- node scripts/retirar-planes-conversia.mjs --aplicar
 *
 * Sin `--aplicar` no escribe nada: imprime exactamente lo que haría.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL } },
});

const APLICAR = process.argv.includes("--aplicar");

/** A dónde va cada plan retirado. Una cuenta real paga Base; las demo y de prueba, Prueba. */
const RETIRAR = [
  { code: "conversia_v2_trial", destino: "conversia_creditos_trial" },
  { code: "conversia_v2_base", destino: "conversia_creditos_base" },
  { code: "conversia_funcionando", destino: "conversia_creditos_trial" },
  { code: "conversia_gestionado", destino: "conversia_creditos_base" },
];

/** Cuentas que se mandan a un plan concreto, por encima de la regla de arriba. */
const DESTINO_POR_ORG = {
  // Cuenta real de Conversia: estaba colgada del plan "starter" de TuBot (marca cruzada).
  "digital-dent-temuco": "conversia_creditos_base",
};

function clp(v) {
  return v === null || v === undefined ? "-" : `$${Number(v).toLocaleString("es-CL")}`;
}

async function main() {
  console.log(APLICAR ? "=== APLICANDO ===" : "=== SIMULACIÓN (sin --aplicar no escribe nada) ===");

  const codigos = [...RETIRAR.map((r) => r.code), ...new Set(RETIRAR.map((r) => r.destino))];
  const planes = await prisma.plan.findMany({ where: { code: { in: codigos } } });
  const porCode = new Map(planes.map((p) => [p.code, p]));

  // Un destino que no existe aborta TODO: mover a un plan inexistente es peor que no mover.
  for (const r of RETIRAR) {
    if (!porCode.get(r.destino)) throw new Error(`El plan destino ${r.destino} no existe en esta base. Corré seed-conversia-catalog.mjs primero.`);
  }

  const acciones = [];

  // 1) Suscripciones que viven en un plan a retirar.
  for (const r of RETIRAR) {
    const plan = porCode.get(r.code);
    if (!plan) {
      console.log(`\n· ${r.code}: no existe en esta base, nada que hacer.`);
      continue;
    }
    const subs = await prisma.subscription.findMany({
      where: { planId: plan.id },
      select: { id: true, status: true, organizationId: true },
    });
    const orgs = subs.length
      ? await prisma.organization.findMany({
          where: { id: { in: subs.map((s) => s.organizationId) } },
          select: { id: true, slug: true, brand: true },
        })
      : [];
    const slugPorId = new Map(orgs.map((o) => [o.id, o.slug]));

    console.log(`\n· ${r.code} «${plan.name}» ${clp(plan.priceClp)} — activo=${plan.active} · ${subs.length} suscripción(es)`);
    for (const s of subs) {
      const slug = slugPorId.get(s.organizationId) ?? s.organizationId;
      const destino = porCode.get(DESTINO_POR_ORG[slug] ?? r.destino);
      console.log(`    ${slug} (${s.status}) → ${destino.code} «${destino.name}» ${clp(destino.priceClp)}`);
      acciones.push({ tipo: "mover", subId: s.id, planId: destino.id });
    }
    if (plan.active) acciones.push({ tipo: "apagar", planId: plan.id, code: r.code });
  }

  // 2) Cuentas de marca conversia colgadas de un plan de OTRA marca.
  const cruzadas = await prisma.$queryRawUnsafe(`
    SELECT o.slug, s.id AS sub_id, s.status, pl.code AS plan_code, pl.brand AS plan_brand
      FROM organizations o
      JOIN subscriptions s ON s.organization_id = o.id AND s.status IN ('ACTIVE','TRIALING')
      JOIN plans pl ON pl.id = s.plan_id
     WHERE o.brand = 'conversia' AND o.deleted_at IS NULL AND pl.brand <> 'conversia'`);
  if (cruzadas.length) {
    console.log(`\n· cuentas de Conversia en un plan de otra marca (${cruzadas.length}):`);
    for (const c of cruzadas) {
      const destinoCode = DESTINO_POR_ORG[c.slug];
      if (!destinoCode) {
        console.log(`    ${c.slug}: en ${c.plan_code} (${c.plan_brand}) — SIN destino definido, no se toca.`);
        continue;
      }
      const destino = porCode.get(destinoCode);
      console.log(`    ${c.slug}: ${c.plan_code} (${c.plan_brand}) → ${destino.code} «${destino.name}» ${clp(destino.priceClp)}`);
      acciones.push({ tipo: "mover", subId: c.sub_id, planId: destino.id });
    }
  }

  const mover = acciones.filter((a) => a.tipo === "mover");
  const apagar = acciones.filter((a) => a.tipo === "apagar");
  console.log(`\nRESUMEN: ${mover.length} suscripción(es) a mover · ${apagar.length} plan(es) a apagar`);

  if (!APLICAR) {
    console.log("\n(simulación: no se escribió nada. Volvé a correrlo con --aplicar)");
    return;
  }

  // Todo junto: si algo falla, no queda un tenant en un plan apagado.
  await prisma.$transaction(async (tx) => {
    for (const a of mover) {
      await tx.subscription.update({ where: { id: a.subId }, data: { planId: a.planId } });
    }
    for (const a of apagar) {
      await tx.plan.update({ where: { id: a.planId }, data: { active: false, isPublic: false } });
    }
  });
  console.log("\nAplicado. Verificación:");

  const despues = await prisma.plan.findMany({
    where: { brand: "conversia" },
    select: { code: true, name: true, priceClp: true, active: true, isPublic: true },
    orderBy: [{ active: "desc" }, { order: "asc" }],
  });
  for (const p of despues) {
    const subs = await prisma.subscription.count({ where: { planId: (await prisma.plan.findUnique({ where: { code: p.code }, select: { id: true } })).id } });
    console.log(`  ${p.active ? "✓ ACTIVO  " : "· retirado"} ${p.code} «${p.name}» ${clp(p.priceClp)} público=${p.isPublic} · ${subs} suscripción(es)`);
  }
  const quedanCruzadas = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM organizations o
      JOIN subscriptions s ON s.organization_id=o.id AND s.status IN ('ACTIVE','TRIALING')
      JOIN plans pl ON pl.id=s.plan_id
     WHERE o.brand='conversia' AND o.deleted_at IS NULL AND pl.brand <> 'conversia'`);
  console.log(`  cuentas de Conversia en plan de otra marca: ${quedanCruzadas[0].n}`);
}

main()
  .catch((e) => {
    console.error("FALLÓ:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
