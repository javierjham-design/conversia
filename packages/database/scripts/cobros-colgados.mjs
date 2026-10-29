#!/usr/bin/env node
/**
 * COBROS COLGADOS — qué intentos de pago quedaron a medias y qué va a pasar con cada uno.
 *
 * **SOLO LEE.** Sirve para correrlo en producción antes de desplegar el worker.
 *
 *   railway run -s Postgres -- bash -c 'cd packages/database && DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/cobros-colgados.mjs'
 *
 * Por qué existe: el worker nuevo cambia qué pasa con un intento `pending` que quedó colgado,
 * y eso toca a las DOS marcas.
 *
 *  - Un intento de SUSCRIPCIÓN (`sub-`) sin token no se podía reconsultar, y "esta cuenta
 *    tiene un cobro en vuelo" lo veía sin mirar la fecha: a esa cuenta no se la volvía a
 *    cobrar NUNCA, en silencio. El worker nuevo lo cierra y el ciclo normal la vuelve a
 *    intentar — o sea que **al desplegar, esas cuentas se van a cobrar**. Hay que mirar antes
 *    si alguna ya pagó por otra vía, porque si no se le cobra dos veces.
 *  - Un intento de RECARGA (`rec-`) con token lo resuelve la reconciliación consultando la
 *    pasarela: si está pagado, acredita; si está rechazado, lo cierra. Eso no cobra nada
 *    nuevo, así que no hay nada que revisar antes.
 *
 * No escribe, no llama a la pasarela y no imprime datos de tarjeta. Solo cuenta y lista.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Mismo umbral que usa el worker para dar por colgado un intento de suscripción. */
const HORAS_HUERFANO = 6;

const fecha = (d) => new Date(d).toISOString().slice(0, 16).replace("T", " ");
const clp = (n) => `$${Math.round(Number(n ?? 0)).toLocaleString("es-CL")}`;

async function main() {
  const limite = new Date(Date.now() - HORAS_HUERFANO * 3_600_000);
  const pendientes = await prisma.paymentAttempt.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  if (pendientes.length === 0) {
    console.log("✔ No hay ningún intento de cobro en estado `pending`. Nada que revisar antes de desplegar.");
    return;
  }

  // Marca y nombre de cada organización involucrada, en una sola consulta.
  const orgIds = [...new Set(pendientes.map((p) => p.organizationId))];
  const orgs = new Map(
    (await prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, brand: true } })).map((o) => [
      o.id,
      o,
    ]),
  );

  const esRecarga = (p) => p.commerceOrder.startsWith("rec-");
  const esLink = (p) => p.commerceOrder.startsWith("lnk-");
  // LO QUE HAY QUE MIRAR: suscripción, sin token y viejo. Es el único grupo que, al
  // desplegar, pasa de "no se cobra nunca" a "se cobra en el próximo ciclo".
  const seVanACobrar = pendientes.filter((p) => !esRecarga(p) && !esLink(p) && !p.providerRef && p.createdAt <= limite);
  const subConToken = pendientes.filter((p) => !esRecarga(p) && !esLink(p) && p.providerRef);
  const recargas = pendientes.filter(esRecarga);
  const links = pendientes.filter(esLink);
  const subRecientes = pendientes.filter((p) => !esRecarga(p) && !esLink(p) && !p.providerRef && p.createdAt > limite);

  console.log(`\n${pendientes.length} intento(s) de cobro en estado \`pending\`:\n`);

  const bloque = (titulo, filas, nota) => {
    console.log(`── ${titulo}: ${filas.length}`);
    if (filas.length === 0) {
      console.log("     (ninguno)\n");
      return;
    }
    for (const p of filas) {
      const o = orgs.get(p.organizationId);
      console.log(
        `     ${fecha(p.createdAt)} · ${(o?.brand ?? "?").padEnd(9)} · ${(o?.name ?? p.organizationId).slice(0, 34).padEnd(34)} · ` +
          `${clp(p.amount).padStart(10)} · ${p.commerceOrder}`,
      );
    }
    console.log(`     → ${nota}\n`);
  };

  bloque(
    "⚠ SUSCRIPCIÓN SIN TOKEN y con más de " + HORAS_HUERFANO + " h — ESTOS SE VAN A COBRAR al desplegar",
    seVanACobrar,
    "Revisá en el panel de la pasarela si alguno YA se pagó. Si se pagó y acá sigue pendiente, " +
      "cerralo a mano ANTES de desplegar o se le cobra dos veces.",
  );
  bloque(
    "Suscripción sin token pero RECIENTE",
    subRecientes,
    "Todavía dentro de la ventana: puede estar resolviéndose. Se revisa solo en el próximo pase.",
  );
  bloque(
    "Suscripción CON token",
    subConToken,
    "La reconciliación los resuelve consultando la pasarela (ya lo hacía antes). No cobra nada nuevo.",
  );
  bloque(
    "Recargas de créditos (rec-)",
    recargas,
    "Los resuelve la reconciliación de recargas: si están pagados acredita, si no los cierra. No cobra nada nuevo.",
  );
  bloque("Links de pago (lnk-)", links, "Los paga el cliente cuando quiere; no hay cobro automático detrás.");

  if (seVanACobrar.length === 0) {
    console.log("✔ VEREDICTO: no hay ninguna cuenta que pase de 'nunca se cobra' a 'se cobra'. Podés desplegar.\n");
  } else {
    console.log(
      `✖ VEREDICTO: ${seVanACobrar.length} cuenta(s) se van a cobrar al desplegar el worker.\n` +
        "  Mirá cada una en la pasarela antes de desplegar.\n",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
