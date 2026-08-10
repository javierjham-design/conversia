import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";

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

interface Caps {
  perTenant: number;
  global: number;
}
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
 * Comprueba si el tenant puede enviar UNA plantilla ahora. Incrementa los
 * contadores diarios (por intento). Devuelve el motivo + un mensaje claro para
 * mostrar en la bandeja si se bloquea.
 */
export async function guardTemplateSend(organizationId: string): Promise<SendGate> {
  const prisma = getAdminPrisma();

  // 1-2. Estado de negocio (demo / suspensión / gracia). Fail-open si no se lee.
  try {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true, settings: true } });
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

    // 3-4. Topes. Fail-open si Redis falla.
    const caps = await resolveCaps(organizationId, (org?.settings ?? {}) as Record<string, any>);
    try {
      const d = today();
      const tKey = `msgcap:t:${organizationId}:${d}`;
      const tN = await conn().incr(tKey);
      if (tN === 1) await conn().expire(tKey, 172_800);
      if (tN > caps.perTenant) {
        return block("tenant_cap", "Alcanzaste el límite diario de envíos de plantilla de tu cuenta. Se reanuda mañana; si necesitas más, escríbenos por Soporte para ampliarlo.");
      }
      const gKey = `msgcap:g:${d}`;
      const gN = await conn().incr(gKey);
      if (gN === 1) await conn().expire(gKey, 172_800);
      if (gN > caps.global) {
        await tripFuse(d, gN, caps.global);
        return block("global_fuse", "Los envíos de plantilla están en pausa temporal por una medida de seguridad de la plataforma. Ya estamos revisándolo; tu conversación no se pierde.");
      }
    } catch {
      /* Redis caído → no bloqueamos la operación por el contador. */
    }
  } catch {
    /* No se pudo leer estado → fail open (igual que hoy, sin guard). */
  }
  return { blocked: false };
}

async function resolveCaps(organizationId: string, settings: Record<string, any>): Promise<Caps> {
  const g = await readGlobalCaps();
  const override = Number(settings?.messaging?.dailyCap);
  const perTenant = Number.isFinite(override) && override > 0 ? override : g.perTenantDefault;
  return { perTenant, global: g.global };
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
