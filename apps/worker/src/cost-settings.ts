import { getAdminPrisma } from "@conversia/database";
import type { WhatsappRates } from "@conversia/agents";

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
