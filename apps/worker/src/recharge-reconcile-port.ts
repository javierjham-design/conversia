import { getEnv } from "@conversia/config";
import { getAdminPrisma, raiseException, withTenant } from "@conversia/database";
import { enqueueNotification } from "./notifications/queue";
import { RECHARGE_ORDER_PREFIX } from "./auto-recharge";
import type { RechargeReconcilePort } from "./recharge-reconcile";

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

    async notificar(organizationId, _kind, data) {
      await enqueueNotification({ eventKey: "credits.auto_recharge_failed", organizationId, data });
    },

    async raiseOps(organizationId, input) {
      await raiseException(admin, { organizationId, ...input });
    },
  };
}
