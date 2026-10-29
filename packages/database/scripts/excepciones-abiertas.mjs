#!/usr/bin/env node
/**
 * QUÉ EXCEPCIONES HAY ABIERTAS EN LA PLATAFORMA (solo lectura).
 *
 * Las excepciones (`platform_exceptions`) son el canal por el que el producto avisa de cosas
 * que ningún test puede ver porque dependen de los datos reales de los clientes: un canal
 * enviando con el token global, una tarjeta agotada, una batería de QA en rojo. La consola
 * las muestra; esto las resume desde afuera para decidir con números en vez de con impresiones.
 *
 * Nació para una decisión concreta (28-oct-2026): `WA_GLOBAL_TOKEN_FALLBACK` sigue en `ok`
 * —el token global de WhatsApp se ve pero no se corta— a la espera de mirar unos días cuántos
 * canales lo están usando. Cortar sin mirar deja clientes mudos; no mirar nunca deja la
 * decisión abierta para siempre.
 *
 *   railway run -s Postgres -- node -e "process.env.DATABASE_URL=process.env.DATABASE_PUBLIC_URL;import('./packages/database/scripts/excepciones-abiertas.mjs')"
 *
 * Desde la RAÍZ del repo: `railway` resuelve el proyecto por el directorio donde se lo invoca.
 * Variables: DIAS (default 14), TIPO (filtra por tipo exacto).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DIAS = Number(process.env.DIAS ?? 14);
const TIPO = (process.env.TIPO ?? "").trim();

const desde = new Date(Date.now() - DIAS * 86_400_000);

async function main() {
  const where = {
    createdAt: { gte: desde },
    ...(TIPO ? { type: TIPO } : {}),
  };

  const total = await prisma.platformException.count({ where });
  if (!total) {
    console.log(`\nNinguna excepción en los últimos ${DIAS} día(s)${TIPO ? ` del tipo ${TIPO}` : ""}.`);
    return;
  }

  const porTipo = await prisma.platformException.groupBy({
    by: ["type", "status", "severity"],
    where,
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });

  console.log(`\n${total} excepción(es) en los últimos ${DIAS} día(s):\n`);
  const abiertas = new Map();
  for (const g of porTipo) {
    const abierta = g.status === "open" || g.status === "assigned";
    if (abierta) abiertas.set(g.type, (abiertas.get(g.type) ?? 0) + g._count._all);
    console.log(`  ${String(g._count._all).padStart(4)} · ${g.type.padEnd(26)} ${g.status.padEnd(10)} ${g.severity}`);
  }

  if (!abiertas.size) {
    console.log("\nNinguna abierta: todas resueltas o descartadas.");
    return;
  }

  // El detalle importa por ORGANIZACIÓN: "40 excepciones" puede ser un cliente roto o
  // cuarenta clientes con el mismo problema, y la decisión no es la misma.
  console.log(`\nAbiertas, por organización:`);
  for (const tipo of abiertas.keys()) {
    const filas = await prisma.platformException.findMany({
      where: { ...where, type: tipo, status: { in: ["open", "assigned"] } },
      select: { organizationId: true, createdAt: true, title: true },
      orderBy: { createdAt: "desc" },
    });
    const orgs = new Map();
    for (const f of filas) {
      const prev = orgs.get(f.organizationId);
      if (!prev) orgs.set(f.organizationId, { n: 1, ultima: f.createdAt, title: f.title });
      else prev.n++;
    }
    const nombres = await prisma.organization.findMany({
      where: { id: { in: [...orgs.keys()] } },
      select: { id: true, name: true, slug: true, brand: true },
    });
    const porId = new Map(nombres.map((o) => [o.id, o]));
    console.log(`\n  ${tipo} — ${orgs.size} organización(es), ${filas.length} abierta(s)`);
    for (const [orgId, d] of orgs) {
      const o = porId.get(orgId);
      console.log(`    · ${(o ? `${o.name} (${o.slug}, ${o.brand})` : orgId).padEnd(46)} ${String(d.n).padStart(3)} abierta(s)  última ${d.ultima.toISOString().slice(0, 16).replace("T", " ")}`);
    }
    console.log(`      ${filas[0]?.title ?? ""}`);
  }
}

main()
  .catch((e) => {
    console.error("✖", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
