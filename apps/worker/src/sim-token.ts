import IORedis from "ioredis";
import { getEnv } from "@conversia/config";

/**
 * SOLO SIMULACIÓN (stack Docker, WHATSAPP_PROVIDER=mock). Permite simular un token de WhatsApp
 * inválido (Meta 190) en runtime sin reiniciar el worker: el MockChannelProvider consulta este
 * flag tanto al ENVIAR como al VERIFICAR, así se reproduce el fail-fast y el chequeo periódico
 * "sin tráfico", y el "restaurar" del token (borrar el flag). En producción el provider es
 * `meta` y nunca se consulta esto.
 *
 * Valores del flag:
 *   "1" | "all"                        → TODOS los canales fallan (simula el incidente masivo).
 *   "mock:slugA,mock:slugB"            → solo esos phone_number_ids fallan (prueba acotada/rápida).
 * Togglear desde el test:  redis-cli SET sim:wa-token-invalid "mock:slug"   /   DEL sim:wa-token-invalid
 */
export const SIM_WA_TOKEN_INVALID_KEY = "sim:wa-token-invalid";

let client: IORedis | null = null;
function conn(): IORedis {
  if (!client) client = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return client;
}

// Cache corta del valor del flag: el chequeo de salud lo consulta una vez por canal; sin esto, un
// barrido de cientos de canales haría cientos de GET a Redis. 2s basta (una corrida dura segundos).
let cached: { v: string | null; at: number } | null = null;

/**
 * ¿El token de `phoneNumberId` debe simularse inválido? Best-effort (false si falla). Si el flag
 * es "1"/"all" → todos; si es una lista de phone_number_ids → solo los incluidos; sin id y lista
 * específica → false (no aplica al token global salvo "all").
 */
export async function simWaTokenInvalid(phoneNumberId?: string): Promise<boolean> {
  try {
    if (!cached || Date.now() - cached.at > 2000) {
      cached = { v: await conn().get(SIM_WA_TOKEN_INVALID_KEY), at: Date.now() };
    }
    const v = cached.v;
    if (!v) return false;
    if (v === "1" || v === "all") return true;
    if (!phoneNumberId) return false;
    return v.split(",").map((s) => s.trim()).includes(phoneNumberId);
  } catch {
    return false;
  }
}
