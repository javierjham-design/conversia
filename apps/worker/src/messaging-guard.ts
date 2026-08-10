import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { debitForMessage, notifyWalletThresholds, refundForMessage } from "./wallet";

/**
 * MITIGACIÓN PUENTE de exposición financiera (ver docs/SECURITY_AUDIT.md §6).
 * Único guard por el que DEBE pasar todo envío de PLANTILLA (los que cuestan).
 * Corta SOLO plantillas; las respuestas dentro de la ventana de 24 h (servicio,
 * gratis) NO se tocan nunca. Reglas:
 *   1. Demo (TRIAL): bloqueo total de plantillas.
 *   2. Gracia por impago (suscripción PAST_DUE) o suspensión: sin plantillas.
 *   3. Tope duro diario por tenant.
 *   4. Fusible global: techo agregado diario; al cortar, alerta (BetterStack via
 *      /health/fuse + webhook opcional) y bloquea a todos hasta el día siguiente.
 * Falla ABIERTO ante errores de infraestructura (no rompe la operación por un
 * fallo transitorio de Redis), pero los bloqueos de negocio (demo/gracia) sí
 * cierran. El conteo es por intento previo al envío: conservador a propósito.
 */

export type SendGate = { blocked: false } | { blocked: true; reason: string; userMessage: string };

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

const today = () => new Date().toISOString().slice(0, 10);

let capCache: { at: number; global: number; perTenantDefault: number } | null = null;

/** Lee los topes de platform_settings (cache 60 s), con defaults de env. */
async function readGlobalCaps(): Promise<{ global: number; perTenantDefault: number }> {
  if (capCache && Date.now() - capCache.at < 60_000) return capCache;
  const env = getEnv();
  let global = env.MSG_CAP_GLOBAL_DAY;
  let perTenantDefault = env.MSG_CAP_PER_TENANT_DAY;
  try {
    const rows = await getAdminPrisma().platformSetting.findMany({
      where: { key: { in: ["messagingCapGlobalDay", "messagingCapPerTenantDay"] } },
    });
    for (const r of rows) {
      const n = Number(r.value);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (r.key === "messagingCapGlobalDay") global = n;
      if (r.key === "messagingCapPerTenantDay") perTenantDefault = n;
    }
  } catch {
    /* fail open a defaults */
  }
  capCache = { at: Date.now(), global, perTenantDefault };
  return capCache;
}

/** Bloqueo de negocio (demo / suspensión / gracia). null = puede enviar. */
async function businessBlock(organizationId: string): Promise<SendGate | null> {
  const prisma = getAdminPrisma();
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (org?.status === "TRIAL") {
    return block("demo", "En modo demo no se envían plantillas de WhatsApp. Activa un plan para habilitarlas. Puedes seguir probando agentes, flujos y responder dentro de las 24 h.");
  }
  if (org?.status === "SUSPENDED" || org?.status === "CANCELLED") {
    return block("suspended", "Cuenta suspendida por falta de pago: los envíos de plantilla están en pausa. Regulariza tu plan para reactivarlos.");
  }
  const sub = await prisma.subscription.findFirst({ where: { organizationId }, select: { status: true }, orderBy: { createdAt: "desc" } });
  if (sub?.status === "PAST_DUE") {
    return block("grace", "Tu pago está pendiente: los envíos de plantilla se reanudan al regularizar el plan. El resto del panel sigue disponible.");
  }
  return null;
}

/** Tope diario por tenant (rate-limit): evita vaciar toda la bolsa en un día. */
async function perTenantCapBlock(organizationId: string): Promise<SendGate | null> {
  try {
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    const { perTenantDefault } = await readGlobalCaps();
    const override = Number((org?.settings as any)?.messaging?.dailyCap);
    const cap = Number.isFinite(override) && override > 0 ? override : perTenantDefault;
    const key = `msgcap:t:${organizationId}:${today()}`;
    const n = await conn().incr(key);
    if (n === 1) await conn().expire(key, 172_800);
    if (n > cap) {
      return block("tenant_cap", "Alcanzaste el límite diario de envíos de plantilla de tu cuenta. Se reanuda mañana; si necesitas más, escríbenos por Soporte para ampliarlo.");
    }
  } catch {
    /* Redis caído → no bloqueamos por el contador. */
  }
  return null;
}

/** Incrementa el fusible global del día; corta (y alerta) si supera el techo. */
async function globalFuseBlock(): Promise<SendGate | null> {
  try {
    const d = today();
    const { global } = await readGlobalCaps();
    const gKey = `msgcap:g:${d}`;
    const gN = await conn().incr(gKey);
    if (gN === 1) await conn().expire(gKey, 172_800);
    if (gN > global) {
      await tripFuse(d, gN, global);
      return block("global_fuse", "Los envíos de plantilla están en pausa temporal por una medida de seguridad de la plataforma. Ya estamos revisándolo; tu conversación no se pierde.");
    }
  } catch {
    /* Redis caído → no bloqueamos por el contador. */
  }
  return null;
}

/**
 * Cobro de UN envío de plantilla: (1) estado de negocio, (2) débito ATÓMICO de la
 * bolsa prepagada (idempotente por messageId; sin saldo → bloquea), (3) fusible
 * global (red de plataforma; si corta tras debitar, devuelve el crédito). Corta
 * solo plantillas; el servicio (24 h) nunca llama a esto. Falla ABIERTO ante
 * errores de infraestructura, pero los bloqueos de negocio/saldo cierran.
 */
export async function chargeTemplateSend(
  organizationId: string,
  messageId: string,
  category: string | null | undefined,
  costUsd?: number,
): Promise<SendGate> {
  try {
    const biz = await businessBlock(organizationId);
    if (biz) return biz;

    // Rate-limit diario por tenant (antes de tocar la bolsa).
    const cap = await perTenantCapBlock(organizationId);
    if (cap) return cap;

    // Débito de bolsa (previo al envío). Sin saldo → no sale.
    const debit = await debitForMessage(organizationId, messageId, category, costUsd);
    if (!debit.ok) {
      void notifyWalletThresholds(organizationId, 0);
      return block("no_balance", "Se agotó tu bolsa de mensajes de plantilla. Compra un paquete adicional o sube de plan para reanudar los envíos. Puedes seguir respondiendo dentro de las 24 h sin costo.");
    }
    if (!debit.already) void notifyWalletThresholds(organizationId, debit.balance);

    // Fusible global (última red). Si corta tras debitar, se devuelve el crédito.
    const fuse = await globalFuseBlock();
    if (fuse) {
      await refundForMessage(organizationId, messageId).catch(() => undefined);
      return fuse;
    }
  } catch {
    /* No se pudo verificar → fail open (no romper la operación por un fallo). */
  }
  return { blocked: false };
}

function block(reason: string, userMessage: string): SendGate {
  return { blocked: true, reason, userMessage };
}

/** Marca el fusible (para /health/fuse) y alerta UNA vez por día. */
async function tripFuse(date: string, count: number, cap: number): Promise<void> {
  try {
    await conn().set(`msgcap:fuse:${date}`, "1", "EX", 172_800);
    const firstTrip = await conn().set(`msgcap:fuse-alerted:${date}`, "1", "EX", 172_800, "NX");
    console.error(`🚨 FUSIBLE DE MENSAJERÍA CORTADO — ${count} plantillas hoy supera el techo global ${cap}. Envíos de plantilla en pausa para todos los tenants.`);
    if (firstTrip) {
      const url = getEnv().OPS_ALERT_WEBHOOK_URL;
      if (url) {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary: "TuBot: fusible de mensajería cortado",
            description: `Se superó el techo global diario de plantillas (${count} > ${cap}). Envíos de plantilla en pausa para todos los tenants hasta revisión.`,
            severity: "critical",
          }),
        }).catch(() => undefined);
      }
    }
  } catch {
    /* best-effort */
  }
}

/** ¿El fusible está cortado hoy? Lo usa el endpoint /health/fuse. */
export async function isFuseTripped(): Promise<boolean> {
  try {
    return (await conn().get(`msgcap:fuse:${today()}`)) === "1";
  } catch {
    return false;
  }
}
