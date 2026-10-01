import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { computeWhatsappCostUsd } from "@conversia/agents";
import { geoFromPhone } from "./phone-geo";
import { getWhatsappRatesOverride, getWhatsappRateSchedule } from "./cost-settings";

/**
 * MEDICIÓN DE MENSAJES DE SERVICIO (plan servicio-octubre-2026, etapa E2).
 *
 * Desde el 2026-10-01 Meta cobra los mensajes de servicio (respuestas del bot
 * dentro de la ventana de 24 h) sobre un free tier de 1.000/mes POR NÚMERO. Esta
 * etapa deja RASTRO Y COSTO ESTIMADO de cada envío de servicio, sin frenar nada
 * (los topes son E3). La bolsa prepagada es SOLO de plantillas: el asiento de
 * servicio va con delta 0 (no altera balance).
 *
 * DOS FUENTES DE COSTO, NUNCA SE SUMAN (ver docs/BILLING.md):
 *  - `wallet_ledger` reason "service_send" = ESTIMACIÓN al enviar (esta función).
 *  - `usage_events` type "whatsapp_message" = VERDAD de Meta (webhook, con billable).
 *  Se concilian por el mensaje: wallet_ledger.refId == message.id, y
 *  usage_events.meta.externalId == message.externalId.
 */

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

/** Umbral de free tier por número y mes (platform_settings), cacheado 60 s. */
let freeTierCache: { at: number; limit: number } | null = null;
export async function getServiceFreeTierLimit(): Promise<number> {
  if (freeTierCache && Date.now() - freeTierCache.at < 60_000) return freeTierCache.limit;
  let limit = 1000; // default Meta: 1.000 mensajes de servicio gratis/mes por número.
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: "serviceFreeTierPerNumber" } });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) limit = Math.round(n);
    }
  } catch {
    /* default */
  }
  freeTierCache = { at: Date.now(), limit };
  return limit;
}

/** Mes UTC (YYYY-MM) para la ventana del contador. */
function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * Incrementa y devuelve el contador mensual de mensajes de servicio del número.
 * Redis es la fuente operativa (TTL ~40 días); si falla, devuelve null (fail-open
 * conservador: el caller cobra tarifa, no regala). La BD permite auditar/reconstruir
 * contando los asientos service_send del mes (no se crea tabla: E2 es sin migración).
 */
async function bumpServiceCounter(phoneNumberId: string, at: Date): Promise<number | null> {
  try {
    const key = `svc:ft:${phoneNumberId}:${monthKey(at)}`;
    const count = await conn().incr(key);
    if (count === 1) await conn().expire(key, 40 * 24 * 3600);
    return count;
  } catch {
    return null;
  }
}

/**
 * ¿El número AÚN está dentro del free tier de servicio de este mes (sin consumir el
 * cupo gratis)? Lee el contador SIN incrementarlo (el incremento lo hace
 * recordServiceSend post-éxito). Lo usa F5-B para decidir si el débito de créditos
 * aplica. Fail conservador: ante error, devuelve false (NO exime → se cobra).
 *
 * NOTA (hallazgo Meta): Meta resetea el free tier mensual en la ZONA HORARIA de la
 * WABA; este contador usa mes calendario UTC. El desfase (~3-4 h en Chile en el borde
 * del mes) se afina pasando la zona de la org — pendiente de F5-B parte 2.
 */
export async function isWithinServiceFreeTier(phoneNumberId: string): Promise<boolean> {
  try {
    const key = `svc:ft:${phoneNumberId}:${monthKey(new Date())}`;
    const current = Number(await conn().get(key)) || 0;
    const limit = await getServiceFreeTierLimit();
    return current < limit;
  } catch {
    return false;
  }
}

/**
 * Registra UN mensaje de servicio saliente ya enviado con éxito. Idempotente por
 * messageId (un reintento no escribe dos veces ni re-cuenta el free tier).
 * Best-effort: un fallo de registro NUNCA tumba el envío (ya ocurrió).
 *
 * @param phoneNumberId número de NEGOCIO que envió (clave del free tier de Meta).
 * @param toPhone destinatario (para el país y la tarifa por país).
 */
export async function recordServiceSend(
  organizationId: string,
  messageId: string,
  conversationId: string,
  toPhone: string,
  phoneNumberId: string,
): Promise<void> {
  try {
    const prisma = getAdminPrisma();
    // Idempotencia por messageId (mismo patrón que debitForMessage).
    const prev = await prisma.walletLedger.findFirst({
      where: { organizationId, reason: "service_send", refType: "message", refId: messageId },
      select: { id: true },
    });
    if (prev) return;

    const at = new Date();
    // Free tier POR NÚMERO (contador de este mes). Bajo el umbral → costo 0; sobre
    // él → tarifa del schedule. Si Redis falla (count null) cobramos tarifa (no
    // regalamos); la verdad fiscal la pone el webhook en usage_events.
    const count = await bumpServiceCounter(phoneNumberId, at);
    const limit = await getServiceFreeTierLimit();
    const withinFreeTier = count !== null && count <= limit;

    const costUsd = withinFreeTier
      ? 0
      : computeWhatsappCostUsd("service", geoFromPhone(toPhone).country, await getWhatsappRatesOverride(), {
          at,
          schedule: await getWhatsappRateSchedule(),
        });

    // La bolsa es SOLO de plantillas: delta 0, no altera balance ni balanceAfter.
    // costUsd 0 = free tier o pre-octubre (WalletLedger no tiene columna meta y E2
    // es sin migración; el flag de free tier se refleja en el costo y se audita
    // contra usage_events.billable).
    const wallet = await prisma.messageWallet.findUnique({ where: { organizationId }, select: { balance: true } });
    const balanceAfter = wallet?.balance ?? 0;
    await prisma.walletLedger.create({
      data: {
        organizationId,
        delta: 0,
        reason: "service_send",
        balanceAfter,
        category: "service",
        costUsd,
        refType: "message",
        refId: messageId,
      },
    });
    void conversationId; // en el contrato por trazabilidad/futuro (UsageEvent "conversation" es E3).
    // TODO E3: emitir UsageEvent type "conversation" (depende del contador de la migración de E3).
    // TODO F5-B: para marcas con serviceDebitsWallet, el débito de créditos reusa este contador de free tier.
  } catch (err) {
    console.error(`✖ recordServiceSend (${organizationId}/${messageId}):`, (err as Error).message);
  }
}
