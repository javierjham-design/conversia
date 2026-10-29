import { brandOf, getEnv } from "@conversia/config";
import { getAdminPrisma, raiseException, withTenant } from "@conversia/database";
import { enqueueNotification } from "./notifications/queue";
import { RECHARGE_ORDER_PREFIX } from "./auto-recharge";
import { FlowSubscriptionProvider } from "./subscription-billing/flow-provider";
import { resolveSubscriptionProvider } from "./subscription-billing/resolve-provider";
import type { RechargeReconcilePort } from "./recharge-reconcile";

/**
 * Prefijo del `commerceOrder` de un LINK de pago único (§4).
 *
 * Distinto del de recarga automática (`rec-`) y del de suscripción (`sub-`): este cobro no
 * tiene un intento en `payment_attempts` que cerrar —lo paga el cliente cuando quiere— así
 * que ni la reconciliación de recargas ni el motor de suscripciones deben verlo como algo
 * suyo. Lo único que lo procesa es el webhook, que acredita por la metadata.
 */
export const PREFIJO_ORDEN_LINK = "lnk-";

/**
 * CRE — implementación real del puerto de reconciliación de recargas. Acá está todo el SQL
 * y ninguna decisión: las reglas viven en `recharge-reconcile.ts`.
 */

/** Cuántos intentos se revisan por pase. Más que esto es un incidente, no un pase. */
const TOPE_POR_PASE = 200;

export function createDbRechargeReconcilePort(): RechargeReconcilePort {
  const admin = getAdminPrisma();

  return {
    async listPendientes() {
      const rows = await admin.paymentAttempt.findMany({
        where: { commerceOrder: { startsWith: RECHARGE_ORDER_PREFIX }, status: "pending" },
        select: { organizationId: true, commerceOrder: true, providerRef: true, amount: true, createdAt: true },
        orderBy: { createdAt: "asc" }, // los más viejos primero: son los que llevan más tiempo sin créditos
        take: TOPE_POR_PASE,
      });
      return rows.map((r) => ({
        organizationId: r.organizationId,
        commerceOrder: r.commerceOrder,
        providerRef: r.providerRef ?? null,
        amountClp: Number(r.amount),
        createdAt: r.createdAt,
      }));
    },

    async reaplicarWebhook({ providerRef }) {
      // Exactamente la llamada que hace Flow a `urlConfirmation`, con el mismo token. El
      // endpoint reconsulta el estado a la pasarela con NUESTRA clave (no confía en este
      // POST), valida el monto contra el emitido, deduplica por el token y acredita. Por eso
      // reaplicar es seguro aunque el webhook original llegue un segundo después.
      //
      // Es un POST sin firma a propósito: la ruta es pública porque la llama la pasarela, y
      // su seguridad no está en quién la llama sino en que el estado del pago se vuelve a
      // consultar firmado. Un token inventado no acredita nada.
      const url = `${getEnv().API_URL}/billing/webhooks/flow`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: providerRef }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`webhook ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
    },

    async creditoAcreditado(organizationId, providerRef) {
      // Se busca el asiento por el TOKEN del pago, que es el `refId` con el que acredita el
      // webhook. Se miran las dos bolsas: los packs de créditos y conversaciones asientan en
      // el libro de lotes, y los de plantillas en el de la bolsa de mensajes. Una recarga
      // automática siempre es de créditos, pero preguntar por las dos cuesta una consulta y
      // evita una alerta falsa de "pagó y no recibió nada" si algún día cambia el pack.
      const enLotes = await withTenant(organizationId, (tx) =>
        tx.conversationCreditLedger.findFirst({
          where: { organizationId, reason: "package_purchase", refId: providerRef },
          select: { id: true },
        }),
      ).catch(() => null);
      if (enLotes) return true;
      const enBolsa = await admin.walletLedger
        .findFirst({ where: { organizationId, reason: "package_purchase", refId: providerRef }, select: { id: true } })
        .catch(() => null);
      return Boolean(enBolsa);
    },

    async cerrarIntento(commerceOrder, status, reason) {
      // Solo si sigue pendiente: si el webhook llegó entremedio y ya lo cerró, su resultado
      // manda. Pisar un `succeeded` con un `failed` sería borrar un cobro real del historial.
      await admin.paymentAttempt.updateMany({
        where: { commerceOrder, status: "pending" },
        data: { status, reason: reason ?? undefined },
      });
    },

    async notificar(organizationId, kind, data) {
      // §4 — el aviso de "tu tarjeta no sirve para cobros automáticos" es OTRO mensaje que
      // el de "tu tarjeta rechazó el cobro": el primero le pide cambiar de tarjeta o pagar
      // con el link, el segundo le pide revisar su cupo. Decirle lo segundo cuando pasa lo
      // primero lo manda a mirar donde no está el problema.
      const eventKey = kind === "tarjeta_no_apta" ? "credits.tarjeta_no_apta" : "credits.auto_recharge_failed";
      await enqueueNotification({ eventKey, organizationId, data });
    },

    async marcarTarjetaApta(organizationId) {
      // Solo levanta marcas: nunca pone `false`. Y solo toca las que están en `false`, para
      // no pisar el `null` de una tarjeta que todavía no se probó con un dato que no tenemos.
      await admin.paymentMethod.updateMany({
        where: { organizationId, provider: "flow", autoChargeable: false },
        data: { autoChargeable: true },
      });
    },

    async marcarTarjetaNoApta(organizationId) {
      // Se marcan TODAS las tarjetas de Flow de la org, no solo la que está por defecto: si
      // el cliente dejó más de una, ninguna de ellas pasó la prueba del cobro recurrente y
      // marcar una sola dejaría a la recarga automática intentando con la otra.
      await admin.paymentMethod.updateMany({
        where: { organizationId, provider: "flow" },
        data: { autoChargeable: false },
      });
    },

    async linkDePago(organizationId, montoClp) {
      // El plan B: una página de pago que acepta cualquier medio —débito incluido— porque el
      // pago es único. Lo acredita el MISMO webhook que el cobro automático, por la metadata.
      const provider = await resolveSubscriptionProvider(organizationId);
      if (!(provider instanceof FlowSubscriptionProvider)) return null;
      const org = await admin.organization.findUnique({ where: { id: organizationId }, select: { brand: true, currency: true } });
      // El pack se elige por MONTO: es el que la recarga automática iba a cobrar, así que el
      // link tiene que ser por lo mismo (si no, el cliente paga una cifra y recibe otra).
      const pack = await admin.messagePackage.findFirst({
        where: { brand: "conversia", type: "credit", priceClp: Math.round(montoClp) },
        select: { code: true, credits: true, name: true, priceClp: true },
      });
      if (!pack) return null;
      const env = getEnv();
      const dueno = await admin.organizationUser.findFirst({ where: { organizationId }, orderBy: { createdAt: "asc" }, select: { userId: true } });
      const user = dueno ? await admin.user.findUnique({ where: { id: dueno.userId }, select: { email: true } }) : null;
      const r = await provider.crearLinkDePago({
        commerceOrder: `${PREFIJO_ORDEN_LINK}${organizationId}-${Date.now()}`,
        subject: `${brandOf(org).paymentSubjectPrefix} · ${pack.credits.toLocaleString("es-CL")} Créditos IA`,
        amount: pack.priceClp,
        currency: org?.currency ?? "CLP",
        email: user?.email ?? `pagos+${organizationId.slice(-8)}@conversia.cl`,
        urlConfirmation: `${env.API_URL}/billing/webhooks/flow`,
        urlReturn: `${env.WEB_URL}/cobros?pago=1`,
        // La misma metadata que el cobro automático: el webhook acredita por el camino de
        // siempre y con la misma idempotencia.
        metadata: {
          organizationId,
          planCode: `pkg:${pack.code}`,
          expectedAmount: String(pack.priceClp),
          linkDePago: "1",
        },
      });
      return r.url;
    },

    async raiseOps(organizationId, input) {
      await raiseException(admin, { organizationId, ...input });
    },
  };
}
