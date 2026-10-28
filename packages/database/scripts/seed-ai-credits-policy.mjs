#!/usr/bin/env node
/**
 * CRE 1 — siembra `platform_settings.aiCredits`: la política de Créditos IA (pesos por
 * modelo, tamaño del bloque de tokens, gracia y modelo estándar de los bots nuevos).
 *
 * Los valores son los calibrados con los costos reales de producción del §4/§7 de
 * `docs/MODELO_COBRO_CREDITOS_IA.md`. Desde acá el dueño los cambia sin desplegar: el
 * worker y la API releen esta fila cada 60 s.
 *
 * NO siembra planes, packs ni precios: eso es la Etapa 2 (catálogo), y va inactivo hasta
 * que el dueño apruebe los precios. Esta fila sola no le cobra nada a nadie — el cobro
 * solo se activa cuando un plan tiene `features.aiCreditsWallet`.
 *
 * Idempotente:
 *   DATABASE_URL=... node packages/database/scripts/seed-ai-credits-policy.mjs
 *   DATABASE_URL=... node packages/database/scripts/seed-ai-credits-policy.mjs --dry-run
 */
import { PrismaClient } from "@prisma/client";

const KEY = "aiCredits";

// Mismos valores que `CREDIT_POLICY_SEED` en packages/agents/src/credit-formula.ts. Si
// cambian ahí, cambian acá: el código los usa solo cuando esta fila no existe todavía.
const policy = {
  tokensPerCredit: 20000,
  models: {
    "gpt-4o-mini": { level: "standard", credits: 1 },
    "claude-haiku-4-5": { level: "plus", credits: 4 },
    "gpt-4o": { level: "advanced", credits: 12 },
    "claude-sonnet-4-6": { level: "advanced", credits: 20 },
    "claude-opus-4-6": { level: "premium", credits: 50 },
    "claude-opus-4-7": { level: "premium", credits: 50 },
    "claude-opus-4-8": { level: "premium", credits: 50 },
    "claude-fable-5": { level: "premium", credits: 50 },
  },
  unknownModel: { level: "premium", credits: 50 },
  graceCredits: 100,
  defaultModel: "gpt-4o-mini",
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const prisma = new PrismaClient();
  try {
    const actual = await prisma.platformSetting.findUnique({ where: { key: KEY } });
    if (actual) {
      console.log(`· ${KEY} ya existe; valor actual:\n${actual.value}`);
    } else {
      console.log(`· ${KEY} no existe todavía`);
    }
    if (dryRun) {
      console.log(`\n(dry-run) escribiría:\n${JSON.stringify(policy, null, 2)}`);
      return;
    }
    await prisma.platformSetting.upsert({
      where: { key: KEY },
      update: { value: JSON.stringify(policy) },
      create: { key: KEY, value: JSON.stringify(policy) },
    });
    console.log(
      `✔ ${KEY} sembrado: bloque ${policy.tokensPerCredit} tokens · gracia ${policy.graceCredits} créditos · ` +
        `estándar ${policy.defaultModel} · ${Object.keys(policy.models).length} modelos con peso`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
