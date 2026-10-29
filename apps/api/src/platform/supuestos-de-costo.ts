import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupuestosDeCosto } from "@conversia/agents";

/**
 * LOS SUPUESTOS DE COSTO, leídos del MISMO archivo que el test del catálogo.
 *
 * `packages/database/seeds/creditos-catalogo.json` es la única fuente de los costos con los
 * que se decide si un precio es vendible: cuánto nos cuesta un crédito, la comisión de la
 * pasarela, el IVA y el piso de ganancia. Que la pantalla del super admin y el test lean el
 * mismo archivo es lo que hace que "la misma cuenta que el test" sea literal: si alguien
 * cambia un supuesto, se mueven los dos a la vez.
 *
 * Se lee UNA vez y se guarda: es un archivo del repo, no cambia en caliente. Si no se puede
 * leer devuelve null y el llamador NO inventa un veredicto — rechazar un precio por un
 * archivo que no se pudo abrir sería peor que dejarlo pasar con el cambio auditado.
 */
let cache: SupuestosDeCosto | null | undefined;

export function leerSupuestosDeCosto(): SupuestosDeCosto | null {
  if (cache !== undefined) return cache;
  try {
    const ruta = join(__dirname, "..", "..", "..", "..", "packages", "database", "seeds", "creditos-catalogo.json");
    const j = JSON.parse(readFileSync(ruta, "utf-8")) as { supuestos?: Record<string, unknown> };
    const s = j.supuestos ?? {};
    const n = (v: unknown) => {
      const x = Number(v);
      return Number.isFinite(x) && x > 0 ? x : NaN;
    };
    const out = {
      costoPorCreditoClp: n(s.costoPorCreditoClp),
      comisionFlowPct: n(s.comisionFlowPct),
      costoFijoPorClienteClp: n(s.costoFijoPorClienteClp),
      ivaPct: n(s.ivaPct),
      gananciaMinimaPct: n(s.gananciaMinimaPct),
    };
    cache = Object.values(out).every((v) => Number.isFinite(v)) ? (out as SupuestosDeCosto) : null;
  } catch {
    cache = null;
  }
  return cache;
}
