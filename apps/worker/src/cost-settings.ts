import { getAdminPrisma } from "@conversia/database";
import type { WhatsappRates, WhatsappRateSchedule } from "@conversia/agents";

/** Override editable de tarifas de WhatsApp (platform_settings), cacheado 60 s. */
let cache: { rates: Record<string, WhatsappRates>; at: number } | null = null;

export async function getWhatsappRatesOverride(): Promise<Record<string, WhatsappRates>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rates;
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: "whatsappRates" } });
    const rates = row ? (JSON.parse(row.value) as Record<string, WhatsappRates>) : {};
    cache = { rates, at: Date.now() };
    return rates;
  } catch {
    return cache?.rates ?? {};
  }
}

/**
 * Calendario de tarifas con fecha de vigencia (platform_settings key
 * "whatsappRateSchedule"), cacheado 60 s. Key SEPARADA de "whatsappRates" a
 * propósito: el zod del PATCH /platform/cost-settings hace strip de campos
 * desconocidos y el merge de la calculadora del admin pisaría los tramos si
 * vivieran dentro de "whatsappRates". JSON inválido o key ausente → {} (fail open
 * a "sin schedule"). AÚN NO se conecta a ningún envío: eso es la etapa E2.
 */
let scheduleCache: { schedule: WhatsappRateSchedule; at: number } | null = null;

export async function getWhatsappRateSchedule(): Promise<WhatsappRateSchedule> {
  if (scheduleCache && Date.now() - scheduleCache.at < 60_000) return scheduleCache.schedule;
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: "whatsappRateSchedule" } });
    const schedule = row ? (JSON.parse(row.value) as WhatsappRateSchedule) : {};
    scheduleCache = { schedule, at: Date.now() };
    return schedule;
  } catch {
    return scheduleCache?.schedule ?? {};
  }
}
