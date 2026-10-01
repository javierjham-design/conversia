import { getAdminPrisma } from "@conversia/database";

/**
 * Guarda de "UNA SOLA RESPUESTA POR TURNO" (plan servicio-octubre-2026, etapa E4).
 *
 * Desde el 2026-10-01 cada mensaje de servicio de WhatsApp cuesta: un bot que
 * responde en 4 burbujas gasta 4x. El invariante ya se cumple (el orquestador
 * devuelve UN string y concatena las auto-continuaciones; agent-turn crea UN
 * message). Este módulo consolida el invariante de forma configurable para que un
 * cambio futuro no lo rompa: el tope por turno y la regla de fusión viven aquí.
 */

let cache: { at: number; max: number } | null = null;

/**
 * Tope de mensajes de texto del agente por invocación de turno (platform_settings
 * key "maxAgentMessagesPerTurn"), cacheado 60 s. Default 1. La transferencia entre
 * agentes es OTRA invocación de runAgentTurn (depth 1), así que el tope aplica por
 * invocación y no rompe la derivación (hasta 2 mensajes por mensaje del cliente).
 */
export async function readMaxAgentMessagesPerTurn(): Promise<number> {
  if (cache && Date.now() - cache.at < 60_000) return cache.max;
  let max = 1;
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: "maxAgentMessagesPerTurn" } });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 1) max = Math.round(n);
    }
  } catch {
    /* default */
  }
  cache = { at: Date.now(), max };
  return max;
}

/**
 * Fusiona varias partes de texto del agente en UNA sola respuesta (separadas por
 * salto de línea, descartando vacíos). Es la regla de fusión que cualquier emisor de
 * texto del agente debe usar si alguna vez produce más de una parte en un turno — en
 * vez de crear un segundo message. Adjuntos (IMAGE/DOCUMENT) y plantillas NO se
 * fusionan (van como message propio por requisito del dueño).
 */
export function mergeAgentTextParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n");
}
