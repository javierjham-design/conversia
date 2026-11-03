import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M0 — GUARDIÁN del ciclo de vida de la prueba.
 *
 * `v2-trial-lifecycle.test.ts` prueba la DECISIÓN (`planV2TrialAction`: cuándo copiloto,
 * cuándo pausa) y seguía verde con el defecto adentro, porque el defecto no estaba en la
 * decisión sino en **a quién se le aplica**: el tick miraba solo `conversia_v2_trial`, así que
 * al encender los Créditos IA las cuentas nuevas quedaban sin ciclo de vida —prueba infinita y
 * gratis, en silencio—. Lo mismo con los avisos, que traían "30 conversaciones" y
 * "Base $18.900" escritos a mano: el modelo que esa cuenta justamente no tiene.
 *
 * Es un escáner porque `startV2TrialLifecycle` arma su propio Prisma con imports dinámicos:
 * montar todo eso probaría el andamio, no la consulta.
 */

const ARCHIVO = resolve(__dirname, "./v2-trial-lifecycle.ts");
const src = readFileSync(ARCHIVO, "utf8");

describe("el ciclo de vida de la prueba cubre LOS DOS modelos de cobro", () => {
  it("consulta los dos planes de prueba, no solo el viejo", () => {
    expect(src).toContain("conversia_v2_trial");
    expect(src).toContain("conversia_creditos_trial");
  });

  it("filtra las suscripciones por el CONJUNTO de planes de prueba", () => {
    // Con `planId: trialPlan.id` (un solo plan) el otro modelo queda afuera.
    expect(src).toMatch(/planId:\s*\{\s*in:/);
    expect(src).not.toMatch(/planId:\s*trialPlan\.id/);
  });

  it("saca el precio del plan Base del catálogo, los DOS", () => {
    expect(src).toContain("conversia_v2_base");
    expect(src).toContain("conversia_creditos_base");
  });
});

describe("los avisos no traen números escritos a mano", () => {
  /** Las líneas que construyen texto para el cliente o para la cola de excepciones. */
  const lineasDeTexto = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .filter((l) => /message:|detail:|title:|cuanto|activar/.test(l));

  it("ningún aviso nombra el precio viejo", () => {
    const culpables = lineasDeTexto.filter((l) => /18[.,]?900/.test(l));
    expect(culpables, `precio escrito a mano en:\n${culpables.join("\n")}`).toEqual([]);
  });

  it("ningún aviso afirma una cantidad fija de conversaciones de regalo", () => {
    // `30 conversaciones` / `tus 30` y variantes. El regalo sale de
    // `features.signupGiftCredits`, que es el MISMO campo que usa `auth.service.ts` para
    // acreditarlo: así el aviso no puede prometer un número distinto del que la cuenta recibió.
    const culpables = lineasDeTexto.filter((l) => /\b30\s*(conversaciones|créditos)/.test(l));
    expect(culpables, `regalo escrito a mano en:\n${culpables.join("\n")}`).toEqual([]);
  });

  it("el regalo y la unidad salen del plan", () => {
    expect(src).toContain("signupGiftCredits");
    expect(src).toMatch(/unidad/);
  });

  it("sigue gateado a la marca conversia (TuBot no entra en este ciclo)", () => {
    expect(src).toContain('brand: "conversia"');
  });
});
