import IORedis from "ioredis";
import { AUTO_RECARGA_DEFAULTS } from "@conversia/agents";
import { getEnv, brandOf } from "@conversia/config";
import { getAdminPrisma, raiseException, withTenant } from "@conversia/database";
import { enqueueNotification } from "./notifications/queue";
import {
  parseAutoRechargeConfig,
  RECHARGE_ORDER_PREFIX,
  type AutoRechargePort,
  type RechargeCandidate,
} from "./auto-recharge";

/**
 * CRE 2 — implementación real del puerto de recarga automática (la de los tests es en
 * memoria). Acá está todo el SQL y ningún criterio: las reglas viven en `auto-recharge.ts`.
 */

/**
 * Defaults del §6: dispara bajo 50 créditos, tope de 10 recargas al mes. Los valores vienen
 * de `@conversia/agents` porque el api los necesita también, y tenerlos escritos en los dos
 * lados es como terminan contradiciéndose.
 */
const DEFAULTS = { threshold: AUTO_RECARGA_DEFAULTS.umbralCreditos, monthlyCapClp: AUTO_RECARGA_DEFAULTS.topeMensualClp };

let redis: IORedis | undefined;
function getRedis(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Cuánto tiempo se considera que una recarga puede seguir "en vuelo".
 *
 * Es el plazo que se le da al webhook de la pasarela para cerrar el intento. Pasado eso se
 * asume que no va a llegar y la cuenta puede volver a intentarlo: sin este plazo, un
 * webhook perdido dejaba la recarga automática apagada para siempre y en silencio.
 */
export const VENTANA_EN_VUELO_MS = 6 * 60 * 60 * 1000;

/**
 * Cuánto se respeta una recarga comprada A MANO antes de volver a cobrar automáticamente.
 *
 * El aviso de saldo bajo manda al cliente a comprar al panel y el tick corre cada 15
 * minutos: sin esta ventana, el cliente compraba su recarga y al rato le llegaba OTRO cobro
 * por lo mismo — dos cobros y el doble de créditos de los que quiso. Una hora cubre de
 * sobra el ida y vuelta de un checkout.
 */
export const VENTANA_COMPRA_MANUAL_MS = 60 * 60 * 1000;

export function createDbAutoRechargePort(): AutoRechargePort {
  const admin = getAdminPrisma();

  return {
    async listCandidates(): Promise<RechargeCandidate[]> {
      // Solo orgs de marca conversia cuyo plan vigente cobra Créditos IA. TuBot no entra
      // ni por error: su bolsa es la de plantillas y no tiene recarga automática.
      const orgs = await admin.organization.findMany({
        where: { brand: "conversia", deletedAt: null, status: "ACTIVE" },
        select: { id: true, name: true, brand: true, currency: true, settings: true },
        take: 2000,
      });
      const out: RechargeCandidate[] = [];
      for (const org of orgs) {
        const settings = (org.settings ?? {}) as Record<string, unknown>;
        const cfg = parseAutoRechargeConfig(settings.autoRecharge, DEFAULTS);
        if (!cfg.enabled) continue; // la mayoría: se descarta sin más consultas
        const sub = await admin.subscription.findFirst({
          where: { organizationId: org.id, status: { in: ["ACTIVE", "TRIALING"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true, planId: true, providerCustomerRef: true },
        });
        if (!sub) continue;
        const plan = await admin.plan.findUnique({ where: { id: sub.planId }, select: { features: true } });
        if (((plan?.features ?? {}) as Record<string, unknown>).aiCreditsWallet !== true) continue;
        out.push({
          organizationId: org.id,
          cfg,
          customerRef: sub.providerCustomerRef ?? null,
          subscriptionId: sub.id,
          currency: org.currency ?? "CLP",
          brandSubject: brandOf(org).paymentSubjectPrefix,
        });
      }
      return out;
    },

    async balanceOf(organizationId) {
      const now = new Date();
      return withTenant(organizationId, async (tx) => {
        const lots = await tx.conversationCreditLot.aggregate({
          _sum: { remaining: true },
          where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        });
        const w = await tx.conversationWallet.findUnique({ where: { organizationId }, select: { graceUsed: true } });
        return (lots._sum.remaining ?? 0) - (w?.graceUsed ?? 0);
      }).catch(() => Number.POSITIVE_INFINITY); // ante un error de BD, "saldo suficiente": no se cobra
    },

    async packOf(code) {
      const p = await admin.messagePackage
        .findUnique({ where: { code }, select: { code: true, credits: true, priceClp: true, active: true, type: true } })
        .catch(() => null);
      // Un pack inactivo o de otra unidad no se cobra: sería venderle algo que ya no existe
      // o saldo que su bot no puede gastar.
      if (!p || !p.active || p.type !== "credit") return null;
      return { code: p.code, credits: p.credits, priceClp: p.priceClp };
    },

    async spentThisMonth(organizationId, now) {
      const rows = await admin.paymentAttempt.findMany({
        where: {
          organizationId,
          commerceOrder: { startsWith: RECHARGE_ORDER_PREFIX },
          status: { in: ["succeeded", "pending"] },
          createdAt: { gte: startOfMonth(now) },
        },
        select: { amount: true },
        take: 500,
      });
      // Los PENDIENTES cuentan contra el tope: si no, un webhook lento dejaría pasar más
      // cobros de los que el cliente autorizó.
      return rows.reduce((a, r) => a + Number(r.amount), 0);
    },

    async hasPendingRecharge(organizationId) {
      // CON VENTANA DE TIEMPO, y esto es lo que hace que la recarga automática siga
      // funcionando el segundo mes.
      //
      // Un intento de recarga lo cierra el webhook de la pasarela. Si ese webhook no llega
      // —se pierde, o el handler devuelve error en todos los reintentos—, el intento queda
      // `pending` para siempre. Y como esta consulta no miraba la fecha, "hay una recarga en
      // vuelo" pasaba a ser verdad PARA SIEMPRE: la cuenta no se volvía a cobrar nunca más,
      // sin un solo log, aunque el cliente nos hubiera autorizado a cobrarle y se estuviera
      // quedando sin saldo. Un cobro una vez en la vida, y en silencio.
      //
      // Con la ventana, un webhook perdido frena la recarga unas horas (lo correcto: no
      // cobrar dos veces mientras pueda estar en curso) y después se vuelve a intentar.
      // Los intentos viejos siguen contando contra el tope mensual, así que una recarga que
      // sí se cobró no se puede colar dos veces por esta puerta.
      const row = await admin.paymentAttempt.findFirst({
        where: {
          organizationId,
          commerceOrder: { startsWith: RECHARGE_ORDER_PREFIX },
          status: "pending",
          createdAt: { gte: new Date(Date.now() - VENTANA_EN_VUELO_MS) },
        },
        select: { id: true },
      });
      return Boolean(row);
    },

    async compraReciente(organizationId, now) {
      // Cualquier acreditación de pack reciente cuenta, venga de donde venga: lo que se
      // evita es cobrarle de nuevo por un saldo que ya recibió.
      const row = await admin.conversationCreditLedger.findFirst({
        where: {
          organizationId,
          reason: "package_purchase",
          createdAt: { gte: new Date(now.getTime() - VENTANA_COMPRA_MANUAL_MS) },
        },
        select: { id: true },
      });
      return Boolean(row);
    },

    async failedRecharges(organizationId) {
      // Se cuentan los fallos CONSECUTIVOS mirando desde el intento más nuevo hacia atrás y
      // parando en el primero que no falló: un rechazo de hace tres meses, con cobros buenos
      // en medio, no tiene que bloquear nada hoy.
      const rows = await admin.paymentAttempt
        .findMany({
          where: { organizationId, commerceOrder: { startsWith: RECHARGE_ORDER_PREFIX } },
          orderBy: { createdAt: "desc" },
          select: { status: true, createdAt: true },
          take: 20,
        })
        .catch(() => []);
      let seguidos = 0;
      let ultimoAt: Date | null = null;
      for (const r of rows) {
        if (r.status !== "failed") break;
        seguidos++;
        if (!ultimoAt) ultimoAt = r.createdAt;
      }
      return { seguidos, ultimoAt };
    },

    async createAttempt(input) {
      await admin.paymentAttempt.create({
        data: {
          organizationId: input.organizationId,
          // La tabla exige una suscripción; se cuelga de la vigente. El motor de
          // suscripciones IGNORA los intentos con prefijo "rec-", así que esto no afecta
          // ni la mensualidad ni la reconciliación.
          subscriptionId: input.subscriptionId ?? "",
          commerceOrder: input.commerceOrder,
          amount: input.amount,
          currency: input.currency,
          kind: "auto",
          attemptNumber: 1,
          status: "pending",
          provider: "flow",
        },
      });
    },

    async markAttempt(commerceOrder, status, providerRef, reason) {
      await admin.paymentAttempt.updateMany({
        where: { commerceOrder },
        data: { status, providerRef: providerRef ?? undefined, reason: reason ?? undefined },
      });
    },

    async notify(organizationId, kind, data) {
      // El catálogo de notificaciones acepta valores planos (se interpolan en el texto).
      const eventKey =
        kind === "recharge_started"
          ? "credits.auto_recharge"
          : kind === "recharge_failed"
            ? "credits.auto_recharge_failed"
            : "credits.auto_recharge_cap";
      await enqueueNotification({ eventKey, organizationId, data });
    },

    async raiseOps(organizationId, input) {
      await raiseException(admin, { organizationId, ...input });
    },

    async firstTimeThisMonth(key) {
      try {
        const r = await getRedis().set(`autorecharge:${key}`, "1", "EX", 40 * 86_400, "NX");
        return r === "OK";
      } catch {
        // Sin Redis preferimos avisar (puede repetirse) antes que callar un aviso de dinero.
        return true;
      }
    },
  };
}
