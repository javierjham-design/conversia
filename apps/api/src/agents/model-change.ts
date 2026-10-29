import { getAdminPrisma, leerMuestraConsumoCreditos, leerPromedioDelRubro, withTenant } from "@conversia/database";
import { estimarAlcance, weightOfModel, type CreditPolicy } from "@conversia/agents";
import { modelChangeImpact, readAiModelPolicy } from "./model-policy";

/**
 * CRE 1 — CAMBIO DE MODELO CON AVISO Y ACEPTACIÓN DEL CLIENTE (§4).
 *
 * Un modelo más caro multiplica el consumo de Créditos IA del cliente: la misma respuesta
 * cuesta 1 crédito con el estándar y 12 con gpt-4o. El dueño decidió que eso no se activa
 * a sus espaldas: antes de aplicarlo, el cliente ve cuántos créditos consume el modelo
 * nuevo y para cuántas conversaciones le alcanza su saldo, y lo acepta. Volver al estándar
 * (más barato) no necesita aceptación.
 *
 * DÓNDE VIVE EL PEDIDO: en `organization.settings.ai.modelRequests`, indexado por agente.
 * A propósito, para no agregar una tabla —y con ella una migración— por un evento que
 * ocurre unas pocas veces por cliente. El registro de quién pidió y quién aceptó queda en
 * `audit_logs`, que es append-only y es lo que importa conservar.
 */

export interface PendingModelChange {
  agentId: string;
  agentName: string;
  from: string;
  to: string;
  requestedAt: string;
  requestedByAdminId: string | null;
  /** Lo que se le muestra al cliente, calculado al pedirlo. */
  impact: ReturnType<typeof modelChangeImpact>;
}

type Settings = Record<string, unknown>;

function aiSettings(settings: Settings): Record<string, unknown> {
  const ai = settings.ai;
  return ai && typeof ai === "object" ? { ...(ai as Record<string, unknown>) } : {};
}

function requestsOf(ai: Record<string, unknown>): Record<string, PendingModelChange> {
  const r = ai.modelRequests;
  return r && typeof r === "object" ? ({ ...(r as Record<string, PendingModelChange>) }) : {};
}

async function readSettings(organizationId: string): Promise<Settings> {
  const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return ((org?.settings ?? {}) as Settings) ?? {};
}

async function writeRequests(organizationId: string, mutate: (reqs: Record<string, PendingModelChange>) => void): Promise<void> {
  const settings = await readSettings(organizationId);
  const ai = aiSettings(settings);
  const reqs = requestsOf(ai);
  mutate(reqs);
  ai.modelRequests = reqs;
  await getAdminPrisma().organization.update({
    where: { id: organizationId },
    data: { settings: { ...settings, ai } as object },
  });
}

/** Pedidos de cambio de modelo pendientes de que el cliente acepte. */
export async function readPendingModelChanges(organizationId: string): Promise<PendingModelChange[]> {
  const ai = aiSettings(await readSettings(organizationId));
  return Object.values(requestsOf(ai));
}

export async function savePendingModelChange(organizationId: string, req: PendingModelChange): Promise<void> {
  await writeRequests(organizationId, (reqs) => {
    reqs[req.agentId] = req;
  });
}

/** Saca el pedido (al aceptarlo, rechazarlo o al forzarlo el super admin). */
export async function clearPendingModelChange(organizationId: string, agentId: string): Promise<PendingModelChange | null> {
  const ai = aiSettings(await readSettings(organizationId));
  const existente = requestsOf(ai)[agentId] ?? null;
  if (!existente) return null;
  await writeRequests(organizationId, (reqs) => {
    delete reqs[agentId];
  });
  return existente;
}

/**
 * Escribe el modelo en TODAS las versiones del agente (el override del super admin pisa
 * el del tenant). `null` lo quita y el agente vuelve a heredar el del tenant/plataforma.
 */
export async function applyAgentModel(organizationId: string, agentId: string, model: string | null): Promise<void> {
  const db = getAdminPrisma();
  const versions = await db.agentVersion.findMany({ where: { agentId }, select: { id: true, config: true } });
  for (const v of versions) {
    const config = { ...((v.config ?? {}) as Record<string, unknown>) };
    if (model) config.model = model;
    else delete config.model;
    await db.agentVersion.update({ where: { id: v.id }, data: { config: config as object } });
  }
}

/** Saldo de créditos vigente de la org (lotes no vencidos menos la gracia usada). */
export async function remainingCredits(organizationId: string): Promise<number> {
  const db = getAdminPrisma();
  const now = new Date();
  try {
    const lots = await db.conversationCreditLot.aggregate({
      _sum: { remaining: true },
      where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    });
    const w = await db.conversationWallet.findUnique({ where: { organizationId }, select: { graceUsed: true } });
    return (lots._sum.remaining ?? 0) - (w?.graceUsed ?? 0);
  } catch {
    return 0;
  }
}

/**
 * ¿El plan de la org cobra Créditos IA? La aceptación del cliente se exige SOLO acá.
 *
 * Con el cobro por conversación, cambiar el modelo no cambia lo que paga el cliente (una
 * conversación es un crédito), así que el aviso "tus créditos ahora rinden menos" sería
 * falso. Mandarle un aviso equivocado a un cliente real es peor que no mandarlo.
 */
export async function planChargesAiCredits(organizationId: string): Promise<boolean> {
  try {
    const db = getAdminPrisma();
    const sub = await db.subscription.findFirst({
      where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
      orderBy: { createdAt: "desc" },
      select: { planId: true },
    });
    const plan = sub?.planId
      ? await db.plan.findUnique({ where: { id: sub.planId }, select: { features: true } })
      : await db.plan.findUnique({ where: { code: "free" }, select: { features: true } });
    return ((plan?.features ?? {}) as Record<string, unknown>).aiCreditsWallet === true;
  } catch {
    return false;
  }
}

export interface ModelOption {
  model: string;
  level: string;
  creditsPerReply: number;
  /** false = no se ofrece en autoservicio (premium) */
  selfServe: boolean;
}

/** Opciones de modelo con su peso en créditos, para el selector del super admin. */
export async function modelOptions(): Promise<ModelOption[]> {
  const policy = await readAiModelPolicy();
  return Object.entries(policy.models)
    .map(([model, w]) => ({ model, level: w.level as string, creditsPerReply: w.credits, selfServe: w.level !== "premium" }))
    .sort((a, b) => a.creditsPerReply - b.creditsPerReply);
}

/** ¿El modelo destino es más caro que el actual? (lo que dispara la aceptación) */
export async function isMoreExpensive(from: string, to: string): Promise<boolean> {
  const policy = await readAiModelPolicy();
  return weightOfModel(to, policy).credits > weightOfModel(from, policy).credits;
}

export type ModelChangeAction = "aplicar" | "pedir_aceptacion" | "forzar";

/**
 * QUÉ HACER con un cambio de modelo. Pura, para poder probar la regla sin levantar Nest:
 * es la decisión que define si el cliente se entera antes o después de que le suba el
 * consumo.
 *
 * - Más barato, igual, o quitar el override → se aplica y listo (volver al estándar no
 *   necesita que nadie acepte nada).
 * - Más caro pero el plan NO cobra Créditos IA → se aplica: el modelo no cambia lo que
 *   paga ese cliente, y un aviso sobre créditos que no usa sería mentira.
 * - Más caro y el plan cobra Créditos IA → se le pide al cliente, salvo que el super
 *   admin fuerce (y entonces debe dejar el motivo).
 */
export function decideModelChange(input: {
  current: string;
  requested: string | null;
  chargesCredits: boolean;
  force?: boolean;
  creditsOf: (model: string) => number;
}): ModelChangeAction {
  const { current, requested, chargesCredits, creditsOf } = input;
  if (!requested || requested === current) return "aplicar";
  if (!chargesCredits) return "aplicar";
  if (creditsOf(requested) <= creditsOf(current)) return "aplicar";
  return input.force ? "forzar" : "pedir_aceptacion";
}

/**
 * Cuántos créditos le cuesta una conversación a este cliente **medidos al modelo estándar**.
 *
 * Sale del MISMO estimador que alimenta el medidor de /inicio y /cobros, los avisos y el
 * copiloto (`estimarAlcance` + `leerMuestraConsumoCreditos`). Lo que agrega acá es la
 * normalización: la muestra está cobrada al peso del modelo que el cliente usa HOY, y
 * `modelChangeImpact` vuelve a multiplicar por el peso de cada lado, así que sin dividir
 * primero el modelo se contaría dos veces (un cliente en gpt-4o vería su saldo rendir 12
 * veces menos de lo que rinde).
 *
 * Cada lectura accesoria degrada a su valor neutro: si la muestra no se puede leer, el
 * impacto se calcula con el respaldo del estimador en vez de romper la pantalla.
 */
async function creditosPorConversacionAEstandar(organizationId: string, modeloActual: string, policy: CreditPolicy): Promise<number | undefined> {
  try {
    const admin = getAdminPrisma();
    const org = await admin.organization.findUnique({ where: { id: organizationId }, select: { settings: true } }).catch(() => null);
    const rubro = String((((org?.settings ?? {}) as Record<string, any>).general ?? {}).industry ?? "");
    const propio = await withTenant(organizationId, (tx) => leerMuestraConsumoCreditos(tx, organizationId)).catch(() => ({
      conversaciones: 0,
      creditos: 0,
      dias: 0,
    }));
    const promedioDelRubro = await leerPromedioDelRubro(admin, rubro).catch(() => null);
    const e = estimarAlcance({ restantes: 0, propio, promedioDelRubro });
    // Sin datos propios ni del rubro, `estimarAlcance` ya devuelve el respaldo compartido:
    // devolverlo explícito o no da lo mismo, pero así una sola función decide el número.
    const peso = Math.max(1, weightOfModel(modeloActual, policy).credits);
    return Math.max(0.1, e.creditosPorConversacion / peso);
  } catch {
    return undefined;
  }
}

/** Impacto en el lenguaje del cliente, con su saldo real y su consumo real. */
export async function buildImpact(organizationId: string, from: string, to: string) {
  const policy = await readAiModelPolicy();
  return modelChangeImpact({
    from,
    to,
    remainingCredits: await remainingCredits(organizationId),
    policy,
    creditsPerConversationAtStandard: await creditosPorConversacionAEstandar(organizationId, from, policy),
  });
}
