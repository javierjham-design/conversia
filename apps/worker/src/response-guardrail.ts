import IORedis from "ioredis";
import { getEnv } from "@conversia/config";

/**
 * V2-1 — GUARDRAIL ECONÓMICO de respuestas por conversación (CONVERSIA_V2.md §2.1). El
 * margen lo decide el nº de respuestas del bot por conversación (objetivo ≤8). Tope BLANDO
 * de 12 respuestas/conversación/día: al alcanzarlo, el agente recibe instrucción de modo
 * conciso/resumen — NUNCA se calla (agrupa y cierra). Contador en Redis (día en zona local).
 */
const SOFT_CAP = 12;
let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}
function dayKey(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Instrucción de modo conciso si la conversación ya superó el tope blando de respuestas HOY. */
export async function guardrailInstruction(conversationId: string, tz = "America/Santiago"): Promise<string> {
  try {
    const n = Number(await conn().get(`guard:resp:${conversationId}:${dayKey(tz)}`)) || 0;
    if (n >= SOFT_CAP) {
      return "\n\n## Modo conciso (muchas respuestas hoy)\nEsta conversación ya tuvo muchas respuestas hoy. Responde de forma BREVE y AGRUPADA: resume en un solo mensaje, ofrece agendar/cerrar o derivar a una persona, y evita repetir. NO dejes de responder.";
    }
    return "";
  } catch {
    return "";
  }
}

/** Suma 1 a las respuestas del bot de esta conversación hoy (tras un envío exitoso). */
export async function bumpResponseGuardrail(conversationId: string, tz = "America/Santiago"): Promise<number> {
  try {
    const k = `guard:resp:${conversationId}:${dayKey(tz)}`;
    const n = await conn().incr(k);
    if (n === 1) await conn().expire(k, 2 * 24 * 3600);
    return n;
  } catch {
    return 0;
  }
}
