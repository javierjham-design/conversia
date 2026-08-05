/**
 * Precios por modelo (USD por millón de tokens) para registrar costo por
 * tenant en ai_requests. Actualizar al cambiar la lista de precios de
 * Anthropic (fuente: platform.claude.com/docs — cache 2026-06).
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI (USD/millón de tokens — fuente: openai.com/pricing, cache 2026-07)
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
};

export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

/**
 * Precio APROXIMADO que Meta cobra por mensaje de WhatsApp (USD), por categoría
 * de plantilla y país del destinatario (modelo per-message vigente 2025+). Los
 * mensajes de SERVICIO (respuestas dentro de la ventana de 24 h) son GRATIS.
 * ⚠️ Las tarifas cambian y varían por país — ACTUALIZAR con la lista oficial de
 * Meta (business.whatsapp.com → pricing). Se guardan categoría, país y conteo en
 * el usage_event, así que aunque la tarifa esté desfasada se puede recalcular.
 * Estos valores son un punto de partida, no la verdad de facturación.
 */
export interface WhatsappRates {
  marketing: number;
  utility: number;
  authentication: number;
  service: number;
}

export const WHATSAPP_PRICING: Record<string, WhatsappRates> = {
  CL: { marketing: 0.0592, utility: 0.0175, authentication: 0.0303, service: 0 },
  MX: { marketing: 0.0436, utility: 0.0119, authentication: 0.0239, service: 0 },
  PE: { marketing: 0.0703, utility: 0.024, authentication: 0.031, service: 0 },
  AR: { marketing: 0.0618, utility: 0.0344, authentication: 0.0367, service: 0 },
  CO: { marketing: 0.0125, utility: 0.0009, authentication: 0.0077, service: 0 },
  // Fallback conservador para países sin tarifa cargada.
  default: { marketing: 0.05, utility: 0.02, authentication: 0.03, service: 0 },
};

/** Costo de un mensaje según categoría + país (ISO). `overrides` desde platform_settings. */
export function computeWhatsappCostUsd(
  category: string | null | undefined,
  countryIso: string | null | undefined,
  overrides?: Record<string, WhatsappRates>,
): number {
  const table = { ...WHATSAPP_PRICING, ...(overrides ?? {}) };
  const rates = table[(countryIso ?? "").toUpperCase()] ?? table.default;
  switch (String(category ?? "").toLowerCase()) {
    case "marketing":
    case "marketing_lite":
      return rates.marketing;
    case "utility":
      return rates.utility;
    case "authentication":
    case "authentication_international":
      return rates.authentication;
    case "service":
      return rates.service;
    default:
      return 0; // categoría desconocida → no se cobra (no inventar costo)
  }
}
