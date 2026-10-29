#!/usr/bin/env node
/**
 * CRE 2 — MIGRAR LOS SALDOS de conversaciones a Créditos IA.
 *
 * Decisión del dueño (§8.4): **cada conversación que le quede al cliente pasa a 10
 * créditos**, conservando el vencimiento original. Como una conversación consume ~4,2
 * créditos, todos GANAN saldo y nadie pierde.
 *
 * DRY-RUN POR DEFECTO: sin `--aplicar` no escribe NADA, solo imprime el antes y el después
 * por organización. Aplicarlo en producción requiere el OK explícito del dueño.
 *
 *   # ver qué haría (no escribe nada):
 *   railway run -s Postgres -- bash -c 'cd packages/database && DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/creditos-migrar-saldos.mjs'
 *   # aplicar de verdad:
 *   railway run -s Postgres -- bash -c 'cd packages/database && DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/creditos-migrar-saldos.mjs --aplicar'
 *
 * Cómo funciona, y por qué así:
 *
 * - Multiplica por 10 el `remaining` de cada lote VIGENTE y deja `amount` igual al nuevo
 *   remaining. Se conserva `expiresAt`: el cliente no gana ni pierde plazo.
 * - La GRACIA usada también se multiplica: si debía 4 conversaciones, debe 40 créditos. Si
 *   no, le perdonaríamos deuda en una unidad y se la cobraríamos en la otra.
 * - **Un asiento por cada lote convertido** más un asiento de cierre con el saldo real. El
 *   libro tiene que poder explicar de dónde salió cada crédito.
 * - **IDEMPOTENTE POR ORGANIZACIÓN**: al convertirla queda un sello
 *   (`refType: "unit_migration"`, `refId: "org:<id>"`) y en la corrida siguiente se salta
 *   completa. El sello es por ORG y no por lote a propósito: si fuera por lote, un pack que
 *   el cliente comprara DESPUÉS de migrar —ya en créditos— se vería como "lote sin
 *   convertir" y se le multiplicaría por 10 otra vez.
 * - Los lotes YA VENCIDOS no se tocan (no son saldo).
 * - No toca TuBot: solo organizaciones de marca conversia.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APLICAR = process.argv.includes("--aplicar");
const FACTOR = 10; // §8.4 — 1 conversación = 10 Créditos IA
const SELLO = "unit_migration";

const num = (n) => Number(n ?? 0).toLocaleString("es-CL");
const vigentes = (now) => ({ remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

async function main() {
  const orgs = await prisma.organization.findMany({
    where: { brand: "conversia", deletedAt: null },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });

  let conSaldo = 0;
  let yaMigradas = 0;
  let lotesTotal = 0;
  let antesTotal = 0;
  let despuesTotal = 0;

  for (const org of orgs) {
    const now = new Date();
    const sellada = await prisma.conversationCreditLedger.findFirst({
      where: { organizationId: org.id, refType: SELLO, refId: `org:${org.id}` },
      select: { createdAt: true },
    });

    const lots = await prisma.conversationCreditLot.findMany({
      where: { organizationId: org.id, ...vigentes(now) },
      orderBy: { createdAt: "asc" },
    });
    const wallet = await prisma.conversationWallet.findUnique({
      where: { organizationId: org.id },
      select: { graceUsed: true },
    });
    const graceUsed = wallet?.graceUsed ?? 0;
    if (lots.length === 0 && graceUsed === 0) continue;

    if (sellada) {
      yaMigradas++;
      console.log(`· ${org.name} (${org.slug}) — YA MIGRADA el ${sellada.createdAt.toISOString().slice(0, 10)}; se salta`);
      continue;
    }

    const sumaLotes = lots.reduce((a, l) => a + l.remaining, 0);
    const antes = sumaLotes - graceUsed;
    const despues = sumaLotes * FACTOR - graceUsed * FACTOR;

    conSaldo++;
    lotesTotal += lots.length;
    antesTotal += antes;
    despuesTotal += despues;

    console.log(
      `· ${org.name} (${org.slug})\n` +
        `    lotes vigentes: ${lots.length}\n` +
        `    saldo: ${num(antes)} conversaciones → ${num(despues)} créditos` +
        `${graceUsed > 0 ? ` · gracia usada: ${num(graceUsed)} → ${num(graceUsed * FACTOR)}` : ""}`,
    );

    if (!APLICAR) continue;

    // Una transacción por organización: o se convierte todo su saldo, o nada.
    await prisma.$transaction(async (tx) => {
      // CERROJO + RELECTURA DENTRO DE LA TRANSACCIÓN.
      //
      // Los valores de arriba se leyeron para IMPRIMIR el antes/después, y escribir con
      // ellos era una carrera contra el worker: si entre la lectura y la escritura el bot
      // cobraba un turno, se escribía `remaining = viejo × 10` —resucitando lo gastado— y
      // el asiento quedaba por un delta que no correspondía al movimiento real. El sello es
      // por organización, así que no hay segunda corrida que lo corrija. Con el cerrojo de
      // aviso (el mismo que usa el cobro) y releyendo acá, la conversión es atómica
      // respecto del tráfico y no hace falta detener el worker.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${org.id}))`;
      // El sello, otra vez y ya con el cerrojo: la lectura de arriba fue para imprimir, y
      // dos corridas del script a la vez la habrían pasado las dos (×100 en vez de ×10).
      const yaSellada = await tx.conversationCreditLedger.findFirst({
        where: { organizationId: org.id, refType: SELLO, refId: `org:${org.id}` },
        select: { id: true },
      });
      if (yaSellada) return;
      const lots = await tx.conversationCreditLot.findMany({
        where: { organizationId: org.id, ...vigentes(new Date()) },
        orderBy: { createdAt: "asc" },
      });
      const w0 = await tx.conversationWallet.findUnique({ where: { organizationId: org.id }, select: { graceUsed: true } });
      const graceUsed = w0?.graceUsed ?? 0;
      const antes = lots.reduce((a, l) => a + l.remaining, 0) - graceUsed;

      // Saldo CORRIENTE, para que cada asiento diga el saldo real tras ese movimiento. Un
      // libro de dinero con `balanceAfter` en 0 no se puede auditar después: hay que poder
      // seguir la cuenta asiento por asiento.
      let corriente = antes;
      for (const l of lots) {
        const nuevo = l.remaining * FACTOR;
        await tx.conversationCreditLot.update({
          where: { id: l.id },
          // `amount` queda igual al remaining nuevo: el lote ya se consumió en parte, y
          // dejar el amount viejo mostraría un "usado" raro en los medidores.
          data: { remaining: nuevo, amount: nuevo },
        });
        corriente += nuevo - l.remaining;
        await tx.conversationCreditLedger.create({
          data: {
            organizationId: org.id,
            delta: nuevo - l.remaining,
            reason: "admin_adjust",
            balanceAfter: corriente,
            refType: SELLO,
            refId: `lote:${l.id}`,
          },
        });
      }
      if (graceUsed > 0) {
        await tx.conversationWallet.update({
          where: { organizationId: org.id },
          data: { graceUsed: graceUsed * FACTOR },
        });
        // La gracia también se convierte, así que la DEUDA del cliente crece ×10. Va como
        // asiento propio: si no, el saldo cambiaría sin que el libro diga por qué.
        const masDeuda = graceUsed * FACTOR - graceUsed;
        corriente -= masDeuda;
        await tx.conversationCreditLedger.create({
          data: {
            organizationId: org.id,
            delta: -masDeuda,
            reason: "admin_adjust",
            balanceAfter: corriente,
            refType: SELLO,
            refId: `gracia:${org.id}`,
          },
        });
      }
      const agg = await tx.conversationCreditLot.aggregate({
        _sum: { remaining: true },
        where: { organizationId: org.id, ...vigentes(new Date()) },
      });
      const w = await tx.conversationWallet.findUnique({ where: { organizationId: org.id }, select: { graceUsed: true } });
      const neto = (agg._sum.remaining ?? 0) - (w?.graceUsed ?? 0);
      // Sello de la organización + saldo final cuadrado. Este asiento es el que hace que
      // la próxima corrida se la salte.
      await tx.conversationCreditLedger.create({
        data: {
          organizationId: org.id,
          delta: 0,
          reason: "admin_adjust",
          balanceAfter: neto,
          refType: SELLO,
          refId: `org:${org.id}`,
        },
      });
    });
  }

  console.log(
    `\n${APLICAR ? "APLICADO" : "DRY-RUN (no se escribió nada)"}\n` +
      `  organizaciones conversia: ${orgs.length}\n` +
      `  por migrar: ${conSaldo}${yaMigradas > 0 ? ` · ya migradas: ${yaMigradas}` : ""}\n` +
      `  lotes a convertir: ${lotesTotal}\n` +
      `  saldo total: ${num(antesTotal)} conversaciones → ${num(despuesTotal)} créditos (×${FACTOR})`,
  );
  if (!APLICAR) console.log("\nPara aplicarlo de verdad: agregá --aplicar (requiere OK del dueño).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
