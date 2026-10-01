import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma, withTenant } from "@conversia/database";
import { debitForMessage, notifyWalletThresholds, refundForMessage } from "./wallet";
import { countConversationOnce } from "./conversation-quota";
import { isWithinServiceFreeTier } from "./service-metering";
import { enqueueNotification } from "./notifications/queue";

/**
 * MITIGACIÓN PUENTE de exposición financiera (ver docs/SECURITY_AUDIT.md §6).
 * Único guard por el que DEBE pasar todo envío de PLANTILLA (los que cuestan).
 * chargeTemplateSend corta SOLO plantillas. Las respuestas dentro de la ventana de
 * 24 h (servicio) desde el 2026-10-01 TAMBIÉN cuestan: las controla chargeServiceSend
 * (más abajo) por cupo de conversaciones (E3), con sus propios topes/fusible. Reglas
 * de chargeTemplateSend:
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

/**
 * Capacidad de plantillas del tenant: (1) el PLAN debe incluirla
 * (features.whatsappTemplates) — los planes básicos NO, independiente del switch;
 * (2) el INTERRUPTOR por-tenant debe estar encendido (settings.messaging.templatesEnabled),
 * que enciende el Super Admin al contratar la capacidad. Es una condición MÁS del
 * gate (no reemplaza bolsa/tope/fusible). null = puede enviar.
 */
async function templatesCapabilityBlock(organizationId: string): Promise<SendGate | null> {
  const prisma = getAdminPrisma();
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const switchOn = ((org?.settings as any)?.messaging?.templatesEnabled) === true;
  const sub = await prisma.subscription.findFirst({
    where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" },
    select: { planId: true },
  });
  const plan = sub
    ? await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } })
    : await prisma.plan.findUnique({ where: { code: "free" }, select: { features: true } });
  const planAllows = ((plan?.features as any)?.whatsappTemplates) === true;
  if (!planAllows) {
    return block("plan_no_templates", "Tu plan no incluye mensajes de plantilla de WhatsApp. Sube de plan para habilitarlos. Puedes seguir respondiendo dentro de las 24 h con tu cupo de conversaciones.");
  }
  if (!switchOn) {
    return block("templates_switch_off", "Los mensajes de plantilla de WhatsApp no están activados para tu cuenta. Escríbenos por Soporte para habilitarlos.");
  }
  return null;
}

/** Bloqueo de negocio (demo / suspensión / gracia). null = puede enviar. */
async function businessBlock(organizationId: string): Promise<SendGate | null> {
  const prisma = getAdminPrisma();
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (org?.status === "TRIAL") {
    return block("demo", "En modo demo no se envían plantillas de WhatsApp. Activa un plan para habilitarlas. Puedes seguir probando agentes, flujos y responder dentro de las 24 h (con el cupo de conversaciones del modo demo).");
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
    // Capacidad de plantillas (plan + interruptor por-tenant): condición previa a
    // todo — si el plan no la incluye o el switch está apagado, no se envía.
    const capability = await templatesCapabilityBlock(organizationId);
    if (capability) return capability;

    const biz = await businessBlock(organizationId);
    if (biz) return biz;

    // Rate-limit diario por tenant (antes de tocar la bolsa).
    const cap = await perTenantCapBlock(organizationId);
    if (cap) return cap;

    // Débito de bolsa (previo al envío). Sin saldo → no sale.
    const debit = await debitForMessage(organizationId, messageId, category, costUsd);
    if (!debit.ok) {
      void notifyWalletThresholds(organizationId, 0);
      return block("no_balance", "Se agotó tu bolsa de mensajes de plantilla. Compra un paquete adicional o sube de plan para reanudar los envíos. Puedes seguir respondiendo dentro de las 24 h con tu cupo de conversaciones.");
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

// ───────────────────────────────────────────────────────────────────────────
// SERVICIO (E3): compuerta SEPARADA de chargeTemplateSend. Controla las respuestas
// del bot en la ventana de 24 h por CUPO DE CONVERSACIONES + topes/fusible propios.
// Los contadores Redis son PARALELOS a los de plantilla: el volumen de servicio es
// 10-100x y compartirlos dispararía el fusible de plantillas.
// ───────────────────────────────────────────────────────────────────────────

let svcCapCache: { at: number; global: number; perTenantDefault: number } | null = null;

async function readGlobalSvcCaps(): Promise<{ global: number; perTenantDefault: number }> {
  if (svcCapCache && Date.now() - svcCapCache.at < 60_000) return svcCapCache;
  const env = getEnv();
  let global = env.MSG_CAP_SVC_GLOBAL_DAY;
  let perTenantDefault = env.MSG_CAP_SVC_PER_TENANT_DAY;
  try {
    const rows = await getAdminPrisma().platformSetting.findMany({
      where: { key: { in: ["messagingCapSvcGlobalDay", "messagingCapSvcPerTenantDay"] } },
    });
    for (const r of rows) {
      const n = Number(r.value);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (r.key === "messagingCapSvcGlobalDay") global = n;
      if (r.key === "messagingCapSvcPerTenantDay") perTenantDefault = n;
    }
  } catch {
    /* fail open a defaults */
  }
  svcCapCache = { at: Date.now(), global, perTenantDefault };
  return svcCapCache;
}

/** SETNX por período para avisos de cupo (una sola vez). */
async function firstTimeSvc(key: string): Promise<boolean> {
  try {
    return (await conn().set(key, "1", "EX", 40 * 24 * 3600, "NX")) === "OK";
  } catch {
    return false;
  }
}

/** ¿El cupo se endurece a tope DURO? Plan, override por tenant, TRIAL o impago. */
async function resolveServiceHardCap(organizationId: string): Promise<boolean> {
  const prisma = getAdminPrisma();
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true, settings: true } });
  if (org?.status === "TRIAL" || org?.status === "SUSPENDED") return true;
  if (((org?.settings as any)?.messaging?.conversationHardCap) === true) return true;
  const anySub = await prisma.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" }, select: { status: true } });
  if (anySub?.status === "PAST_DUE") return true;
  const sub = await prisma.subscription.findFirst({
    where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" },
    select: { planId: true },
  });
  const plan = sub?.planId
    ? await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } })
    : await prisma.plan.findUnique({ where: { code: "free" }, select: { features: true } });
  return ((plan?.features as any)?.conversationHardCap) === true;
}

/** Tope diario de servicio por tenant (contador Redis separado del de plantillas). */
async function perTenantSvcCapBlock(organizationId: string): Promise<SendGate | null> {
  try {
    const { perTenantDefault } = await readGlobalSvcCaps();
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    const override = Number((org?.settings as any)?.messaging?.dailySvcCap);
    const cap = Number.isFinite(override) && override > 0 ? override : perTenantDefault;
    const key = `msgcap:svc:t:${organizationId}:${today()}`;
    const n = await conn().incr(key);
    if (n === 1) await conn().expire(key, 172_800);
    if (n > cap) {
      return block("svc_tenant_cap", "Tu cuenta alcanzó el límite diario de respuestas automáticas. Se reanuda mañana; si necesitas más, escríbenos por Soporte.");
    }
  } catch {
    /* Redis caído → no bloqueamos por el contador. */
  }
  return null;
}

/** Fusible global de servicio (separado del de plantillas). */
async function globalSvcFuseBlock(): Promise<SendGate | null> {
  try {
    const d = today();
    const { global } = await readGlobalSvcCaps();
    const gKey = `msgcap:svc:g:${d}`;
    const gN = await conn().incr(gKey);
    if (gN === 1) await conn().expire(gKey, 172_800);
    if (gN > global) {
      await tripSvcFuse(d, gN, global);
      return block("svc_global_fuse", "Las respuestas automáticas están en pausa temporal por una medida de seguridad de la plataforma. Ya estamos revisándolo; tu conversación no se pierde.");
    }
  } catch {
    /* Redis caído → no bloqueamos por el contador. */
  }
  return null;
}

async function tripSvcFuse(date: string, count: number, cap: number): Promise<void> {
  try {
    await conn().set(`msgcap:svc-fuse:${date}`, "1", "EX", 172_800);
    const firstTrip = await conn().set(`msgcap:svc-fuse-alerted:${date}`, "1", "EX", 172_800, "NX");
    console.error(`🚨 FUSIBLE DE SERVICIO CORTADO — ${count} respuestas de servicio hoy supera el techo global ${cap}. Respuestas automáticas en pausa para todos los tenants.`);
    if (firstTrip) {
      const url = getEnv().OPS_ALERT_WEBHOOK_URL;
      if (url) {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary: "TuBot: fusible de mensajes de servicio cortado",
            description: `Se superó el techo global diario de servicio (${count} > ${cap}). Respuestas automáticas en pausa para todos los tenants hasta revisión.`,
            severity: "critical",
          }),
        }).catch(() => undefined);
      }
    }
  } catch {
    /* best-effort */
  }
}

/** ¿El fusible de servicio está cortado hoy? Lo expone /health/fuse. */
export async function isServiceFuseTripped(): Promise<boolean> {
  try {
    return (await conn().get(`msgcap:svc-fuse:${today()}`)) === "1";
  } catch {
    return false;
  }
}

/** Deja traza del bloqueo por cupo: SYSTEM en la bandeja + integrationEvent + audit_log. */
async function logServiceBlocked(
  organizationId: string,
  conversationId: string,
  quota: { used: number; included: number; periodStart: string },
): Promise<void> {
  try {
    await withTenant(organizationId, async (tx) => {
      await tx.message.create({
        data: {
          organizationId,
          conversationId,
          direction: "OUTBOUND",
          type: "SYSTEM",
          body: "⚠ Cupo de conversaciones alcanzado: el bot pausó las respuestas automáticas de esta conversación. Sube de plan o contáctanos para reanudarlas.",
          authorType: "SYSTEM",
          status: "SENT",
          visibility: "PUBLIC",
        },
      });
      await tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "messaging",
          type: "service.blocked",
          status: "warning",
          message: `Cupo de conversaciones alcanzado (${quota.used}/${quota.included})`,
          payload: { conversationId, used: quota.used, included: quota.included, periodStart: quota.periodStart },
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorType: "system",
          action: "service.blocked",
          entityType: "conversation",
          entityId: conversationId,
          after: { used: quota.used, included: quota.included, periodStart: quota.periodStart },
        },
      });
    });
  } catch {
    /* best-effort */
  }
}

/** ¿El plan vigente de la org debita el servicio de la bolsa (feature serviceDebitsWallet)? */
async function planDebitsService(organizationId: string): Promise<boolean> {
  try {
    const prisma = getAdminPrisma();
    const sub = await prisma.subscription.findFirst({
      where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
      orderBy: { createdAt: "desc" },
      select: { planId: true },
    });
    const plan = sub?.planId ? await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } }) : null;
    return ((plan?.features as any)?.serviceDebitsWallet) === true;
  } catch {
    return false;
  }
}

/**
 * Cobro de UN envío de SERVICIO (respuesta del bot en ventana 24 h): cuenta la
 * conversación en su período, avisa al 80/100 %, corta al 100 % SOLO con tope duro, y
 * aplica tope diario + fusible de servicio. Para planes con serviceDebitsWallet (marca
 * Conversia) además debita créditos (F5-B). Falla ABIERTO ante errores de infra (una
 * caída de Redis/BD no puede callar el bot), pero el corte por tope duro/saldo SÍ cierra.
 */
export async function chargeServiceSend(
  organizationId: string,
  conversationId: string,
  svc?: { messageId?: string; phoneNumberId?: string },
): Promise<SendGate> {
  try {
    const hardCap = await resolveServiceHardCap(organizationId);
    const quota = await countConversationOnce(organizationId, conversationId, new Date(), { hardCap });

    if (quota.blockedByHardCap) {
      const userMessage =
        "⚠ Envío no realizado: tu cuenta alcanzó el cupo de conversaciones del período. El bot pausó las respuestas automáticas. Para reanudarlas hoy mismo: sube de plan o escríbenos por Soporte. Las conversaciones ya abiertas no se pierden.";
      await logServiceBlocked(organizationId, conversationId, quota);
      return block("conversation_cap", userMessage);
    }

    // F5-B: planes con serviceDebitsWallet (marca Conversia) cobran el servicio de la
    // BOLSA (créditos) ANTES del envío, salvo dentro del free tier del número (1.000/mes
    // de Meta). Idempotente por messageId; sin saldo → bloquea. TuBot (sin el feature)
    // nunca entra aquí: su bolsa sigue siendo SOLO de plantillas.
    if (svc?.messageId && (await planDebitsService(organizationId))) {
      const exempt = svc.phoneNumberId ? await isWithinServiceFreeTier(svc.phoneNumberId) : false;
      if (!exempt) {
        const debit = await debitForMessage(organizationId, svc.messageId, "service");
        if (!debit.ok) {
          void notifyWalletThresholds(organizationId, 0);
          return block("no_credits", "Se agotaron tus créditos de Conversia. Compra un sobre o sube de plan para reanudar las respuestas automáticas. Tus conversaciones abiertas no se pierden.");
        }
        if (!debit.already) void notifyWalletThresholds(organizationId, debit.balance);
      }
    }

    // Avisos de cupo (solo con cupo N>0 y si ESTA llamada contó la conversación).
    if (quota.included > 0 && quota.counted) {
      if (quota.used >= quota.included) {
        // Solo en tope BLANDO: "sigues atendiendo sin cortes". En tope duro el aviso es
        // el bloqueo de la siguiente conversación (logServiceBlocked), no este texto.
        if (!hardCap && (await firstTimeSvc(`conv:alerted:limit:${organizationId}:${quota.periodStart}`))) {
          await enqueueNotification({ eventKey: "conversations.limit", organizationId, data: { included: quota.included, used: quota.used } }).catch(() => undefined);
        }
      } else if (quota.overagePct >= 80) {
        if (await firstTimeSvc(`conv:alerted:low:${organizationId}:${quota.periodStart}`)) {
          await enqueueNotification({ eventKey: "conversations.low", organizationId, data: { pct: quota.overagePct, used: quota.used, included: quota.included } }).catch(() => undefined);
        }
      }
    }

    // Tope diario de servicio por tenant → fusible global de servicio.
    const tCap = await perTenantSvcCapBlock(organizationId);
    if (tCap) return tCap;
    const gFuse = await globalSvcFuseBlock();
    if (gFuse) return gFuse;
  } catch {
    /* fail open: una caída de infraestructura no puede callar el bot. */
  }
  return { blocked: false };
}
