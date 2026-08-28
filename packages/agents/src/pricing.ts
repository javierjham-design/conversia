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
 * Costo con caché de prompt (Anthropic): la escritura de caché cuesta 1.25× el
 * input y la lectura 0.1×. `inputTokens` es el input NO cacheado que reporta la
 * API. Con un system prompt/playbook largo cacheado, la lectura repetida abarata
 * el grueso del costo (fuente de multiplicadores: platform.claude.com/docs).
 */
export function computeCostUsdCached(
  model: string,
  t: { inputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; outputTokens: number },
): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  const read = t.cacheReadTokens ?? 0;
  const write = t.cacheCreationTokens ?? 0;
  return (
    (t.inputTokens * p.inputPerMTok +
      write * p.inputPerMTok * 1.25 +
      read * p.inputPerMTok * 0.1 +
      t.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

/**
 * Precio que Meta cobra por mensaje de WhatsApp (per-message, vigente 2025+), por
 * categoría de plantilla y país del destinatario. Los mensajes de SERVICIO
 * (respuestas dentro de la ventana de 24 h) son GRATIS.
 *
 * FUENTE: rate card OFICIAL de Meta "Cost per message in CLP, effective July 1,
 * 2026" (list rate; developers.facebook.com/docs/whatsapp/pricing). Los valores
 * `clp(...)` son los CLP EXACTOS del rate card (verificables contra el PDF), y se
 * convierten a USD con `CLP_PER_USD_REF` para el modelo interno; la facturación en
 * CLP hace el round-trip con el mismo tipo de cambio. Editable en el Super Admin.
 * Nota: usa la LIST RATE (tramo 0); los descuentos por VOLUMEN de utilidad/auth no
 * se modelan (aplican solo a millones de mensajes/mes).
 */
export interface WhatsappRates {
  marketing: number;
  utility: number;
  authentication: number;
  service: number;
}

/** Tipo de cambio de referencia para convertir el rate card CLP de Meta → USD. */
export const CLP_PER_USD_REF = 950;
/** Convierte una fila del rate card (CLP) a USD; servicio siempre gratis. */
const clp = (marketing: number, utility: number, authentication: number): WhatsappRates => ({
  marketing: Number((marketing / CLP_PER_USD_REF).toFixed(5)),
  utility: Number((utility / CLP_PER_USD_REF).toFixed(5)),
  authentication: Number((authentication / CLP_PER_USD_REF).toFixed(5)),
  service: 0,
});

// Rate card oficial de Meta (list rate, CLP → USD @ referencia). Chile primero.
export const WHATSAPP_PRICING: Record<string, WhatsappRates> = {
  CL: clp(78.4917, 17.6584, 17.6584),
  AR: clp(54.5645, 22.956, 22.956),
  BR: clp(55.1826, 6.0039, 6.0039),
  CO: clp(11.0365, 0.7063, 0.7063),
  MX: clp(26.9291, 7.5048, 7.5048),
  PE: clp(62.0694, 17.6584, 17.6584),
  ES: clp(62.4447, 17.6584, 17.6584),
  EG: clp(56.8601, 3.1785, 3.1785),
  FR: clp(75.8429, 26.4876, 26.4876),
  DE: clp(120.5188, 48.5607, 48.5607),
  HK: clp(64.6298, 22.9559, 22.9559),
  HU: clp(75.9312, 30.9022, 30.9022),
  IN: clp(10.4185, 1.2361, 1.2361),
  ID: clp(36.2881, 22.073, 22.073),
  IL: clp(31.1671, 4.6795, 4.6795),
  IT: clp(70.1614, 26.4876, 26.4876),
  MY: clp(75.9312, 12.3609, 12.3609),
  NL: clp(141.0025, 44.1461, 44.1461),
  NG: clp(45.5587, 5.9156, 5.9156),
  PK: clp(41.7622, 8.8292, 8.8292),
  PL: clp(32.3148, 10.7716, 10.7716),
  QA: clp(30.1076, 10.5951, 10.5951),
  RO: clp(75.9312, 25.6047, 25.6047),
  RU: clp(70.8103, 35.3169, 35.3169),
  SA: clp(44.2344, 9.4473, 9.4473),
  SG: clp(64.6298, 14.1267, 14.1267),
  ZA: clp(33.4627, 6.7102, 6.7102),
  TR: clp(9.6238, 0.7946, 0.7946),
  AE: clp(44.0578, 13.8619, 13.8619),
  GB: clp(56.0478, 19.4243, 19.4243),
  // North America (US/CA).
  US: clp(22.073, 3.0019, 3.0019),
  CA: clp(22.073, 3.0019, 3.0019),
  // Rest of Latin America (LATAM no listados individualmente).
  EC: clp(65.3362, 9.977, 9.977),
  BO: clp(65.3362, 9.977, 9.977),
  PY: clp(65.3362, 9.977, 9.977),
  UY: clp(65.3362, 9.977, 9.977),
  VE: clp(65.3362, 9.977, 9.977),
  GT: clp(65.3362, 9.977, 9.977),
  CR: clp(65.3362, 9.977, 9.977),
  PA: clp(65.3362, 9.977, 9.977),
  DO: clp(65.3362, 9.977, 9.977),
  HN: clp(65.3362, 9.977, 9.977),
  NI: clp(65.3362, 9.977, 9.977),
  SV: clp(65.3362, 9.977, 9.977),
  // "Other" (fallback global del rate card).
  default: clp(53.3285, 6.7985, 6.7985),
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
