/**
 * CRE 2 — QUÉ PLAN DE PREPAGO ESTÁ EN VENTA, en un solo lugar.
 *
 * Conversia tiene dos modelos de prepago conviviendo: el viejo por CONVERSACIÓN
 * (`conversia_v2_base`) y el nuevo de CRÉDITOS IA (`conversia_creditos_base`). El go-live
 * apaga uno y enciende el otro, así que "cuál es el plan de prepago" es una pregunta con
 * respuesta cambiante — y por eso tiene que preguntarse una sola vez.
 *
 * Antes no era así: `v2-migrate` ya elegía el plan ACTIVO (créditos si estaba encendido),
 * pero `v2-simulator` leía `conversia_v2_base` escrito a mano. El día del go-live eso dejó
 * al cliente V1 mirando un estimado de "$18.900 + $219 por conversación extra" al lado de
 * un botón que lo iba a dejar en "$24.990 con 300 créditos". El precio prometido no era el
 * que se iba a cobrar, que es exactamente lo que no se puede hacer.
 *
 * Lo ata `apps/api/test/simulador-grandfathering.spec.ts`.
 */

/** Lo mínimo que se necesita de un plan para cotizarlo. */
export type PlanPrepago = {
  code: string;
  active: boolean;
  priceClp: unknown;
  priceUsd: unknown;
  features: unknown;
};

/** Unidad en la que cobra el plan de prepago que está en venta. */
export type UnidadPrepago = "conversation" | "credit";

export const PLAN_CREDITOS = "conversia_creditos_base";
export const PLAN_CONVERSACIONES = "conversia_v2_base";

type LectorDePlanes = {
  plan: { findUnique: (args: { where: { code: string } }) => Promise<PlanPrepago | null> };
};

/**
 * El plan de prepago que HOY se puede contratar, con su unidad. `null` si ninguno de los
 * dos está activo (el dueño todavía no encendió nada): en ese caso no hay nada que cotizar
 * ni a dónde migrar, y quien pregunte tiene que decirlo en vez de inventar un precio.
 *
 * Prioridad: Créditos IA primero. Es el mismo orden que `TRIAL_PLAN_CODES` de
 * `auth.service.ts`, para que "a qué plan entra una cuenta nueva" y "a qué plan migra una
 * cuenta vieja" no puedan apuntar a modelos distintos.
 */
export async function planDePrepagoEnVenta(
  db: LectorDePlanes,
): Promise<{ plan: PlanPrepago; unit: UnidadPrepago } | null> {
  const creditos = await db.plan.findUnique({ where: { code: PLAN_CREDITOS } }).catch(() => null);
  if (creditos?.active === true) return { plan: creditos, unit: "credit" };
  const conversaciones = await db.plan.findUnique({ where: { code: PLAN_CONVERSACIONES } }).catch(() => null);
  if (conversaciones?.active === true) return { plan: conversaciones, unit: "conversation" };
  return null;
}

/** Cuánto trae incluido el plan al mes, en SU unidad. */
export function incluidoDelPlan(plan: PlanPrepago, unit: UnidadPrepago): number {
  const f = (plan.features ?? {}) as Record<string, unknown>;
  const n = Number(unit === "credit" ? f.aiCreditsIncluded : f.conversationsIncluded);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Cortesía del primer mes al migrar, leída del PLAN y no del código: el catálogo de
 * créditos pone 1.000 y el de conversaciones 100, y un "100" escrito a mano regalaría diez
 * veces menos de lo que corresponde el día del cambio.
 */
export function cortesiaDelPlan(plan: PlanPrepago): number {
  const n = Number(((plan.features ?? {}) as Record<string, unknown>).migrationCourtesyCredits);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}
