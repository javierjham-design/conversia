import { getAdminPrisma } from "@conversia/database";

/**
 * CRE 2 — QUÉ PACKS LE CORRESPONDEN A CADA CLIENTE.
 *
 * Conversia tiene dos unidades de cobro conviviendo: la vieja por CONVERSACIÓN y la nueva
 * por CRÉDITOS IA. Los packs de cada una son filas distintas de `message_packages`,
 * separadas por `type` ("conversation" / "credit").
 *
 * Esto resuelve una sola pregunta, en un solo lugar: qué tipo de pack mostrarle y venderle
 * a quien está mirando. Antes había cinco consultas con `type: "conversation"` escrito a
 * mano; el día que se activen los créditos, cada una que quedara sin cambiar le ofrecería
 * al cliente packs de la unidad que ya no usa —y el saldo comprado no le serviría.
 *
 * Los LOTES de saldo son los mismos para las dos unidades (un crédito es un crédito), así
 * que acreditar un pack no cambia; lo que cambia es cuál se ofrece.
 */

export type PackUnit = "conversation" | "credit";

/** Los dos tipos de pack que acreditan la bolsa de LOTES (no la de plantillas). */
export const LOT_PACK_TYPES: PackUnit[] = ["conversation", "credit"];

/** ¿Este tipo de pack acredita lotes? (los de tipo "message" van a la bolsa de plantillas) */
export function isLotPack(type: string | null | undefined): boolean {
  return type === "conversation" || type === "credit";
}

/**
 * Unidad de UNA organización, según lo que cobra su plan vigente. Ante cualquier duda,
 * "conversation": es lo que está vendido y cobrando hoy, así que es el default seguro.
 */
export async function packUnitForOrg(organizationId: string): Promise<PackUnit> {
  try {
    const db = getAdminPrisma();
    const sub = await db.subscription.findFirst({
      where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
      orderBy: { createdAt: "desc" },
      select: { planId: true },
    });
    if (!sub?.planId) return "conversation";
    const plan = await db.plan.findUnique({ where: { id: sub.planId }, select: { features: true } });
    return ((plan?.features ?? {}) as Record<string, unknown>).aiCreditsWallet === true ? "credit" : "conversation";
  } catch {
    return "conversation";
  }
}

/**
 * Unidad de una MARCA, para las páginas públicas (precios, landing), donde todavía no hay
 * organización: la define el catálogo que está activo. Si el plan de créditos ya está
 * activo, lo que se publica son créditos.
 */
export async function packUnitForBrand(brand: string): Promise<PackUnit> {
  if (brand.toLowerCase() !== "conversia") return "conversation";
  try {
    const plan = await getAdminPrisma().plan.findUnique({
      where: { code: "conversia_creditos_base" },
      select: { active: true },
    });
    return plan?.active === true ? "credit" : "conversation";
  } catch {
    return "conversation";
  }
}

/** Cómo se le nombra la unidad al cliente (singular/plural), para los textos del panel. */
export function unitLabel(unit: PackUnit, n: number): string {
  if (unit === "credit") return n === 1 ? "crédito" : "créditos";
  return n === 1 ? "conversación" : "conversaciones";
}
