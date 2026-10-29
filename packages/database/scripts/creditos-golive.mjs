#!/usr/bin/env node
/**
 * CRE 2 — ENCENDER (o apagar) el cobro por Créditos IA de Conversia.
 *
 * Es la ÚNICA acción que pone el modelo nuevo a la venta, y requiere **OK explícito del
 * dueño sobre los precios** (§8.2). Idempotente y reversible. NO toca TuBot.
 *
 * Qué hace al ENCENDER:
 *   1. Planes `conversia_creditos_base` y `conversia_creditos_trial` → active:true
 *      (base también isPublic:true, para que aparezca en precios y se pueda contratar).
 *   2. Packs de Créditos IA (type "credit") → active:true.
 *   3. Plan y packs POR CONVERSACIÓN → active:false, isPublic:false: se dejan de vender,
 *      pero NO se borran (§Etapa 2). Los clientes que ya los tienen siguen operando: su
 *      suscripción apunta al plan por id, y un plan inactivo sigue sirviendo a quien ya lo
 *      contrató — solo deja de ofrecerse.
 *
 * El plan de prueba de las cuentas nuevas se elige por el plan que está ACTIVO
 * (`resolveTrialPlan` en la API), así que este script también cambia a qué modelo entran
 * los registros nuevos. No hay un segundo interruptor que pueda quedar desfasado.
 *
 * ANTES DE ENCENDER, el saldo de los clientes actuales tiene que estar convertido:
 *   node scripts/creditos-migrar-saldos.mjs            # dry-run
 *   node scripts/creditos-migrar-saldos.mjs --aplicar  # con tu OK
 *
 *   # encender:
 *   railway run -s Postgres -- bash -c 'cd packages/database && DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/creditos-golive.mjs'
 *   # apagar (rollback):
 *   railway run -s Postgres -- bash -c 'cd packages/database && OFF=1 DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/creditos-golive.mjs'
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ON = process.env.OFF !== "1";

async function main() {
  // FRENO: sin la fila `platform_settings.aiCredits` el cobro igual funciona —el código cae
  // a la semilla calibrada, a propósito, para que una fila borrada no deje a nadie sin
  // servicio— pero quedaríamos cobrando con una tabla de precios que vive SOLO en un
  // artefacto desplegado: el dueño no podría cambiar un peso sin un deploy, y no habría en
  // la base ningún registro de con qué se cobró. Encender la venta en esas condiciones es
  // justo lo que no se puede hacer. Se arregla con un comando, así que frena en vez de avisar.
  if (ON) {
    const pol = await prisma.platformSetting.findUnique({ where: { key: "aiCredits" } });
    if (!pol) {
      console.error(
        "✖ Falta platform_settings.aiCredits (la política de pesos, bloque de tokens y gracia).\n" +
          "  Sembrala primero:  node scripts/seed-ai-credits-policy.mjs\n" +
          "  (para encender igual, aun sabiendo que el dueño no podrá tocar los pesos sin desplegar: IGNORAR_POLITICA=1)",
      );
      if (process.env.IGNORAR_POLITICA !== "1") process.exit(1);
      console.error("  ⚠ IGNORAR_POLITICA=1: se enciende sin la fila de política.\n");
    } else {
      const p = JSON.parse(pol.value);
      console.log(
        `✔ política vigente: bloque ${p.tokensPerCredit} tokens · gracia ${p.graceCredits} · estándar ${p.defaultModel} · ${Object.keys(p.models ?? {}).length} modelos con peso`,
      );
    }
  }

  // Aviso (no bloquea): si hay saldo sin convertir, al encender quedaría gente con lotes
  // en "conversaciones" gastándose como créditos, o sea 10 veces más rápido.
  if (ON) {
    const orgs = await prisma.organization.findMany({ where: { brand: "conversia", deletedAt: null }, select: { id: true } });
    let sinMigrar = 0;
    for (const o of orgs) {
      const saldo = await prisma.conversationCreditLot.aggregate({
        _sum: { remaining: true },
        where: { organizationId: o.id, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      });
      if ((saldo._sum.remaining ?? 0) <= 0) continue;
      const sello = await prisma.conversationCreditLedger.findFirst({
        where: { organizationId: o.id, refType: "unit_migration", refId: `org:${o.id}` },
        select: { id: true },
      });
      if (!sello) sinMigrar++;
    }
    if (sinMigrar > 0) {
      console.log(
        `⚠ ATENCIÓN: ${sinMigrar} organización(es) con saldo SIN convertir a créditos.\n` +
          `  Su saldo se gastaría 10 veces más rápido de lo que les corresponde.\n` +
          `  Corré primero: node scripts/creditos-migrar-saldos.mjs --aplicar\n`,
      );
    } else {
      console.log("✔ Todas las organizaciones con saldo están ya convertidas a créditos.\n");
    }
  }

  const base = await prisma.plan.updateMany({ where: { code: "conversia_creditos_base" }, data: { active: ON, isPublic: ON } });
  console.log(`✔ conversia_creditos_base active/isPublic = ${ON} (${base.count} fila)`);

  // La prueba es interna: se asigna al registrarse, nunca aparece en precios públicos.
  const trial = await prisma.plan.updateMany({ where: { code: "conversia_creditos_trial" }, data: { active: ON, isPublic: false } });
  console.log(`✔ conversia_creditos_trial active = ${ON} (${trial.count} fila)`);

  const packs = await prisma.messagePackage.updateMany({ where: { brand: "conversia", type: "credit" }, data: { active: ON } });
  console.log(`✔ packs de Créditos IA active = ${ON} (${packs.count} filas)`);

  // El modelo por conversación deja de venderse (o vuelve, en rollback). No se borra nada.
  // El rollback tiene que dejarlo EXACTAMENTE como estaba: el plan base vuelve a aparecer
  // en los precios públicos (isPublic) y la prueba sigue siendo interna. Si el rollback
  // dejara el base activo pero oculto, nadie podría contratar nada hasta correr otro script.
  const convBase = await prisma.plan.updateMany({ where: { code: "conversia_v2_base" }, data: { active: !ON, isPublic: !ON } });
  const convTrial = await prisma.plan.updateMany({ where: { code: "conversia_v2_trial" }, data: { active: !ON, isPublic: false } });
  const convPacks = await prisma.messagePackage.updateMany({ where: { brand: "conversia", type: "conversation" }, data: { active: !ON } });
  console.log(`✔ modelo por conversación active = ${!ON} (planes: ${convBase.count + convTrial.count} · packs: ${convPacks.count})`);

  console.log(
    ON
      ? "\n🟢 CRÉDITOS IA ENCENDIDO. Las cuentas nuevas entran con 200 créditos de prueba y el cobro es por respuesta del bot."
      : "\n⚪ CRÉDITOS IA APAGADO (rollback). Vuelve el cobro por conversación; el catálogo de créditos queda oculto.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
