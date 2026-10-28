import IORedis from "ioredis";
import { getEnv, brandOf, messagingFuseKeys, resolveBrandCap, DEFAULT_BRAND } from "@conversia/config";
import { getAdminPrisma, withTenant, raiseException } from "@conversia/database";
import { debitForMessage, notifyWalletThresholds, refundForMessage, type DebitResult } from "./wallet";
import { opsAlert } from "./ops-alert.js";
import { countConversationOnce } from "./conversation-quota";
import { isWithinServiceFreeTier, resolveServiceWindowTz } from "./service-metering";
import { enqueueNotification } from "./notifications/queue";
import { planDebitsConversation, conversationCreditMultiplier, debitConversation, creditsNotifyDecision, isConversiaOrg } from "./conversation-credits";

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

/** Marca por defecto cuando la organización no la tiene puesta (comportamiento histórico). */
const MARCA_BASE = DEFAULT_BRAND;

/**
 * §6.1 — Marca de la organización, para que el fusible sea POR MARCA.
 *
 * El fusible global es una red de seguridad de plataforma: al cortar, deja a TODOS los
 * tenants sin enviar. Con un solo contador compartido, un pico de Conversia cortaba los
 * envíos de TuBot (y al revés): marcas distintas, clientes distintos, incidentes
 * distintos. Ahora cada marca tiene su contador y su techo.
 */
async function brandOfOrganization(organizationId: string): Promise<string> {
  try {
    const org = await getAdminPrisma().organization.findUnique({
      where: { id: organizationId },
      select: { brand: true },
    });
    return brandOf(org).key;
  } catch {
    return MARCA_BASE; // no se pudo leer → se cuenta donde se contaba antes
  }
}

const capCache = new Map<string, { at: number; global: number; perTenantDefault: number }>();

/**
 * Lee los topes de platform_settings (cache 60 s por marca), con defaults de env.
 *
 * §6.1 — el techo global se busca primero en `messagingCapGlobalDay:<marca>`. El
 * fallback a la clave sin marca es SOLO para tubot: es el valor que el dueño ya
 * configuró para TuBot, y heredarlo en otra marca le daría a Conversia un techo pensado
 * para el volumen de TuBot. Las marcas nuevas caen al default de entorno.
 */
async function readGlobalCaps(brand: string): Promise<{ global: number; perTenantDefault: number }> {
  const hit = capCache.get(brand);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const env = getEnv();
  let global = env.MSG_CAP_GLOBAL_DAY;
  let perTenantDefault = env.MSG_CAP_PER_TENANT_DAY;
  const brandKey = `messagingCapGlobalDay:${brand}`;
  try {
    const rows = await getAdminPrisma().platformSetting.findMany({
      where: { key: { in: [brandKey, "messagingCapGlobalDay", "messagingCapPerTenantDay"] } },
    });
    const byKey = new Map<string, number>();
    for (const r of rows) {
      const n = Number(r.value);
      if (Number.isFinite(n) && n > 0) byKey.set(r.key, n);
    }
    global = resolveBrandCap(brand, { perBrand: byKey.get(brandKey), legacy: byKey.get("messagingCapGlobalDay"), fallback: global });
    perTenantDefault = byKey.get("messagingCapPerTenantDay") ?? perTenantDefault;
  } catch {
    /* fail open a defaults */
  }
  const value = { at: Date.now(), global, perTenantDefault };
  capCache.set(brand, value);
  return value;
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
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { settings: true, brand: true } });
    // La marca sale de la org que ya cargamos (sin consulta extra). El tope POR TENANT no
    // es por marca hoy, pero los topes se leen juntos y así no divergen.
    const { perTenantDefault } = await readGlobalCaps(brandOf(org).key);
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

/** Incrementa el fusible global del día DE SU MARCA; corta (y alerta) si supera el techo. */
async function globalFuseBlock(brand: string): Promise<SendGate | null> {
  try {
    const d = today();
    const { global } = await readGlobalCaps(brand);
    const gKey = messagingFuseKeys(brand, d).templateCounter;
    const gN = await conn().incr(gKey);
    if (gN === 1) await conn().expire(gKey, 172_800);
    if (gN > global) {
      await tripFuse(brand, d, gN, global);
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
  // (1) TOPES Y ESTADO DE NEGOCIO → fallan ABIERTO: un problema de infraestructura no
  //     puede dejar sin enviar a todos los tenants.
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
  } catch {
    /* No se pudo verificar → fail open (no romper la operación por un fallo). */
  }

  // (2) DÉBITO DE BOLSA → falla CERRADO (§9.5). Antes compartía el try/catch fail-open de
  //     arriba: un error de BD dejaba pasar el mensaje SIN cobrarlo, es decir plantillas
  //     gratis a costa de la plataforma y sin rastro. Ahora: un reintento y, si vuelve a
  //     fallar, se BLOQUEA el envío y se alerta a operaciones.
  let debit: DebitResult | undefined;
  for (let intento = 1; intento <= 2 && !debit; intento++) {
    try {
      debit = await debitForMessage(organizationId, messageId, category, costUsd);
    } catch (err) {
      if (intento === 2) {
        const detalle = `No se pudo debitar la bolsa (org ${organizationId}, mensaje ${messageId}): ${(err as Error).message}`;
        console.error(`✖ ${detalle}`);
        await opsAlert({
          summary: "Débito de bolsa caído: envíos de plantilla bloqueados",
          description: detalle,
          severity: "critical",
        }).catch(() => undefined);
        return block(
          "debit_unavailable",
          "No pudimos verificar tu bolsa de mensajes en este momento. Reintenta en unos minutos.",
        );
      }
    }
  }
  if (!debit) {
    return block("debit_unavailable", "No pudimos verificar tu bolsa de mensajes en este momento. Reintenta en unos minutos.");
  }
  if (!debit.ok) {
    void notifyWalletThresholds(organizationId, 0);
    return block("no_balance", "Se agotó tu bolsa de mensajes de plantilla. Compra un paquete adicional o sube de plan para reanudar los envíos. Puedes seguir respondiendo dentro de las 24 h con tu cupo de conversaciones.");
  }
  if (!debit.already) void notifyWalletThresholds(organizationId, debit.balance);

  // (3) Fusible global DE SU MARCA (última red) → fail open. Si corta tras debitar, se
  //     devuelve el crédito.
  try {
    const fuse = await globalFuseBlock(await brandOfOrganization(organizationId));
    if (fuse) {
      await refundForMessage(organizationId, messageId).catch(() => undefined);
      return fuse;
    }
  } catch {
    /* fail open */
  }
  return { blocked: false };
}

function block(reason: string, userMessage: string): SendGate {
  return { blocked: true, reason, userMessage };
}

/** Marca el fusible (para /health/fuse) y alerta UNA vez por día. */
async function tripFuse(brand: string, date: string, count: number, cap: number): Promise<void> {
  try {
    const k = messagingFuseKeys(brand, date);
    await conn().set(k.templateFuse, "1", "EX", 172_800);
    const firstTrip = await conn().set(k.templateAlerted, "1", "EX", 172_800, "NX");
    // La marca va en el mensaje: al cortar, lo primero que hay que saber es a QUIÉN dejó
    // sin enviar, porque ahora el corte NO alcanza a las dos marcas.
    console.error(`🚨 FUSIBLE DE MENSAJERÍA CORTADO (${brand}) — ${count} plantillas hoy supera el techo global ${cap}. Envíos de plantilla en pausa para los tenants de ${brand}.`);
    if (firstTrip) {
      const url = getEnv().OPS_ALERT_WEBHOOK_URL;
      if (url) {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary: `Fusible de mensajería cortado (${brand})`,
            description: `Se superó el techo global diario de plantillas de ${brand} (${count} > ${cap}). Envíos de plantilla en pausa para los tenants de ${brand} hasta revisión.`,
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

const svcCapCache = new Map<string, { at: number; global: number; perTenantDefault: number }>();

/** §6.1 — igual que `readGlobalCaps`, para el fusible de SERVICIO (ventana de 24 h). */
async function readGlobalSvcCaps(brand: string): Promise<{ global: number; perTenantDefault: number }> {
  const hit = svcCapCache.get(brand);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const env = getEnv();
  let global = env.MSG_CAP_SVC_GLOBAL_DAY;
  let perTenantDefault = env.MSG_CAP_SVC_PER_TENANT_DAY;
  const brandKey = `messagingCapSvcGlobalDay:${brand}`;
  try {
    const rows = await getAdminPrisma().platformSetting.findMany({
      where: { key: { in: [brandKey, "messagingCapSvcGlobalDay", "messagingCapSvcPerTenantDay"] } },
    });
    const byKey = new Map<string, number>();
    for (const r of rows) {
      const n = Number(r.value);
      if (Number.isFinite(n) && n > 0) byKey.set(r.key, n);
    }
    global = resolveBrandCap(brand, { perBrand: byKey.get(brandKey), legacy: byKey.get("messagingCapSvcGlobalDay"), fallback: global });
    perTenantDefault = byKey.get("messagingCapSvcPerTenantDay") ?? perTenantDefault;
  } catch {
    /* fail open a defaults */
  }
  const value = { at: Date.now(), global, perTenantDefault };
  svcCapCache.set(brand, value);
  return value;
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
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { settings: true, brand: true } });
    const { perTenantDefault } = await readGlobalSvcCaps(brandOf(org).key);
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

/** Fusible global de servicio (separado del de plantillas), POR MARCA. */
async function globalSvcFuseBlock(brand: string): Promise<SendGate | null> {
  try {
    const d = today();
    const { global } = await readGlobalSvcCaps(brand);
    const gKey = messagingFuseKeys(brand, d).serviceCounter;
    const gN = await conn().incr(gKey);
    if (gN === 1) await conn().expire(gKey, 172_800);
    if (gN > global) {
      await tripSvcFuse(brand, d, gN, global);
      return block("svc_global_fuse", "Las respuestas automáticas están en pausa temporal por una medida de seguridad de la plataforma. Ya estamos revisándolo; tu conversación no se pierde.");
    }
  } catch {
    /* Redis caído → no bloqueamos por el contador. */
  }
  return null;
}

async function tripSvcFuse(brand: string, date: string, count: number, cap: number): Promise<void> {
  try {
    const k = messagingFuseKeys(brand, date);
    await conn().set(k.serviceFuse, "1", "EX", 172_800);
    const firstTrip = await conn().set(k.serviceAlerted, "1", "EX", 172_800, "NX");
    console.error(`🚨 FUSIBLE DE SERVICIO CORTADO (${brand}) — ${count} respuestas de servicio hoy supera el techo global ${cap}. Respuestas automáticas en pausa para los tenants de ${brand}.`);
    if (firstTrip) {
      const url = getEnv().OPS_ALERT_WEBHOOK_URL;
      if (url) {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary: `Fusible de mensajes de servicio cortado (${brand})`,
            description: `Se superó el techo global diario de servicio de ${brand} (${count} > ${cap}). Respuestas automáticas en pausa para los tenants de ${brand} hasta revisión.`,
            severity: "critical",
          }),
        }).catch(() => undefined);
      }
    }
  } catch {
    /* best-effort */
  }
}

/** ¿El fusible de servicio de esa marca está cortado hoy? (`/health/fuse` lee las claves). */
export async function isServiceFuseTripped(brand: string = MARCA_BASE): Promise<boolean> {
  try {
    return (await conn().get(messagingFuseKeys(brand, today()).serviceFuse)) === "1";
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
          // Nota PARA EL EQUIPO en la bandeja (nunca viaja al cliente final): INTERNAL,
          // y sin status SENT (no hubo envío). Hallazgo de la simulación 2026-10-16:
          // con PUBLIC+SENT se confundía con un mensaje realmente enviado al cliente.
          body: "⚠ Cupo de conversaciones alcanzado: el bot pausó las respuestas automáticas de esta conversación. Sube de plan o contáctanos para reanudarlas.",
          authorType: "SYSTEM",
          status: "DELIVERED",
          visibility: "INTERNAL",
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

/** V2-1 — frase de respaldo (configurable por org) cuando se agota la gracia de conversaciones. */
export async function outOfConversationCreditsPhrase(organizationId: string): Promise<string> {
  const DEFAULT = "Por ahora no puedo responderte automáticamente, pero no te preocupes: un miembro del equipo te atenderá a la brevedad.";
  try {
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    const msg = (((org?.settings as Record<string, any> | null)?.messaging ?? {}) as Record<string, any>).outOfCreditsMessage;
    return typeof msg === "string" && msg.trim() ? msg.trim() : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/**
 * ¿El plan vigente de la org debita el servicio de la bolsa (feature serviceDebitsWallet)?
 *
 * §6.6 — DOBLE GUARDA: hace falta que la org sea de marca **conversia** Y que el plan
 * traiga la feature. Cobrar el mensaje de servicio es un modelo de Conversia; en TuBot
 * las respuestas dentro de las 24 h no se cobran. Con la feature sola, un plan de TuBot
 * mal marcado —a mano en el Super Admin, por un seed, o por un loop que recorra todos los
 * planes, como el incidente de V2-7— empezaría a cobrarle a los clientes de TuBot sin
 * que nadie lo pidiera. La marca no se edita desde una pantalla de planes: es el cierre.
 */
async function planDebitsService(organizationId: string): Promise<boolean> {
  try {
    if (!(await isConversiaOrg(organizationId))) return false;
    const prisma = getAdminPrisma();
    const sub = await prisma.subscription.findFirst({
      where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
      orderBy: { createdAt: "desc" },
      select: { planId: true },
    });
    const plan = sub?.planId ? await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } }) : null;
    const feats = (plan?.features ?? {}) as Record<string, unknown>;
    // CRE 1 — con Créditos IA, el mensaje de WhatsApp lo paga el CLIENTE con su tarjeta
    // directo a Meta: la plataforma cobra la IA, no el envío. Si además debitáramos el
    // servicio de la bolsa, el cliente pagaría dos veces el mismo mensaje.
    if (feats.aiCreditsWallet === true) return false;
    return feats.serviceDebitsWallet === true;
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
      const exempt = svc.phoneNumberId ? await isWithinServiceFreeTier(svc.phoneNumberId, await resolveServiceWindowTz(organizationId)) : false;
      if (!exempt) {
        const debit = await debitForMessage(organizationId, svc.messageId, "service");
        if (!debit.ok) {
          void notifyWalletThresholds(organizationId, 0);
          return block("no_credits", "Se agotaron tus créditos de Conversia. Compra un sobre o sube de plan para reanudar las respuestas automáticas. Tus conversaciones abiertas no se pierden.");
        }
        if (!debit.already) void notifyWalletThresholds(organizationId, debit.balance);
      }
    }

    // V2-1: planes con conversationDebitsWallet (modelo V2) debitan 1 CRÉDITO al CONTAR la
    // conversación por primera vez en el período (idempotente de origen: counted una sola vez).
    // Asistente Plus = x2. La GRACIA (20) mantiene al bot vivo; superada, se devuelve el gate
    // "no_conversation_credits" para que el caller envíe la frase de respaldo + derive (no se calla).
    if (quota.counted && (await planDebitsConversation(organizationId))) {
      const multiplier = await conversationCreditMultiplier(organizationId);
      const debit = await debitConversation(organizationId, { conversationId, multiplier });
      if (!debit.ok) {
        await logServiceBlocked(organizationId, conversationId, quota).catch(() => undefined);
        // V2-8: gracia agotada sin recarga → excepción para la cola de operación (dedup por mes).
        await raiseException(getAdminPrisma(), { organizationId, type: "saldo_gracia_sin_recarga", severity: "critical", title: "Saldo en 0 y gracia agotada", detail: "El cliente consumió la gracia de conversaciones sin recargar; el bot está derivando a humano.", dedupeKey: new Date().toISOString().slice(0, 7) }).catch(() => undefined);
        return block("no_conversation_credits", await outOfConversationCreditsPhrase(organizationId));
      }
      // Avisos 75/90% + entrada en gracia (una vez por umbral/período), in-app + WhatsApp.
      const decision = await creditsNotifyDecision(organizationId).catch(() => null);
      if (decision?.fire === "grace") {
        await enqueueNotification({ eventKey: "credits.grace", organizationId, data: { grace: 20 } }).catch(() => undefined);
      } else if (decision?.fire) {
        const pct = decision.included > 0 ? Math.round((decision.used / decision.included) * 100) : 0;
        await enqueueNotification({ eventKey: "credits.low", organizationId, data: { pct, used: decision.used, included: decision.included } }).catch(() => undefined);
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
    const gFuse = await globalSvcFuseBlock(await brandOfOrganization(organizationId));
    if (gFuse) return gFuse;
  } catch {
    /* fail open: una caída de infraestructura no puede callar el bot. */
  }
  return { blocked: false };
}
