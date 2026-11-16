import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";

/**
 * CONFIRMAR EN EL CHAT LO QUE CUESTA DINERO O BORRA DATOS.
 *
 * Decisión del dueño: Convi hace todo, pero lo que cuesta plata o es destructivo pasa por una
 * confirmación explícita en la conversación, y esa confirmación **vale como consentimiento**
 * (se guarda el texto exacto y la hora).
 *
 * Lo importante del diseño está acá: **el `input` de la tool se guarda EN EL SERVIDOR**, no
 * viaja al navegador. El widget solo recibe un `id` y el texto que el dueño va a leer; al
 * confirmar manda ese `id` y nada más. Si el input viajara, un navegador comprometido —o
 * simplemente la consola del navegador— podría cambiar «1.000 créditos, tope $30.000» por
 * «50.000 créditos, sin tope» entre que se muestra y se confirma. Con el input del lado del
 * servidor, lo que se ejecuta es exactamente lo que se leyó.
 *
 * Caduca a los 10 minutos: una confirmación que quedó abierta ayer no puede ejecutarse hoy.
 */

export const TTL_CONFIRMACION_MS = 10 * 60_000;

export interface Confirmacion {
  id: string;
  organizationId: string;
  userId: string;
  /** La tool que se va a ejecutar al confirmar. */
  tool: string;
  /** Sus argumentos, tal como los dejó Convi. NUNCA viajan al navegador. */
  input: Record<string, unknown>;
  /** El texto EXACTO que leyó el dueño. Es lo que se guarda como consentimiento. */
  texto: string;
  creadaEn: number;
}

/** Guarda en Redis con TTL; si Redis no está, en memoria (desarrollo y tests). */
class AlmacenDeConfirmaciones {
  private redis: IORedis | null = null;
  private memoria = new Map<string, Confirmacion>();

  private cliente(): IORedis | null {
    if (this.redis) return this.redis;
    try {
      const url = getEnv().REDIS_URL;
      if (!url) return null;
      this.redis = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
      this.redis.on("error", () => undefined); // Redis caído no puede tumbar el chat
      return this.redis;
    } catch {
      return null;
    }
  }

  private clave(id: string): string {
    return `conversia:convi:confirm:${id}`;
  }

  async guardar(c: Confirmacion): Promise<void> {
    // SIEMPRE en memoria, además de Redis. Si Redis está configurado pero caído, el `set`
    // falla en silencio y la confirmación se guardaría en la nada: el dueño pulsaría
    // «Confirmar» y no pasaría absolutamente nada. Una caída de Redis no puede romper los
    // pagos. Redis se usa para que funcione con varias instancias; la memoria es la red.
    this.memoria.set(c.id, c);
    const r = this.cliente();
    if (r) await r.set(this.clave(c.id), JSON.stringify(c), "PX", TTL_CONFIRMACION_MS).catch(() => undefined);
  }

  /**
   * Lee y BORRA: una confirmación se usa una sola vez. Sin esto, pulsar «Confirmar» dos
   * veces cobraría dos veces, que es el error que nadie perdona.
   */
  async tomar(id: string): Promise<Confirmacion | null> {
    const r = this.cliente();
    if (r) {
      const crudo = await r.get(this.clave(id)).catch(() => null);
      if (crudo) {
        await r.del(this.clave(id)).catch(() => undefined);
        this.memoria.delete(id);
        return JSON.parse(crudo) as Confirmacion;
      }
      // Sin dato en Redis puede ser que caducó (correcto) o que Redis no está respondiendo.
      // La memoria distingue: si acá está y no caducó, es lo segundo.
    }
    const c = this.memoria.get(id) ?? null;
    if (c) this.memoria.delete(id);
    if (c && Date.now() - c.creadaEn > TTL_CONFIRMACION_MS) return null;
    return c;
  }

  /** Solo para tests. */
  _limpiar(): void {
    this.memoria.clear();
  }
}

export const confirmaciones = new AlmacenDeConfirmaciones();

/** Crea la confirmación y devuelve lo ÚNICO que puede ver el navegador. */
export async function pedirConfirmacion(input: {
  organizationId: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  texto: string;
}): Promise<{ id: string; texto: string }> {
  const id = randomUUID();
  await confirmaciones.guardar({
    id,
    organizationId: input.organizationId,
    userId: input.userId,
    tool: input.tool,
    input: input.args,
    texto: input.texto,
    creadaEn: Date.now(),
  });
  return { id, texto: input.texto };
}

/**
 * ¿Esta confirmación se puede ejecutar AHORA y la pidió ESTA persona?
 *
 * Tres condiciones, y las tres importan: que exista (no se usó ya), que no haya caducado, y
 * que el usuario y la organización sean los mismos que la pidieron. Lo último cierra que
 * alguien de otra cuenta adivine un id y dispare un cobro ajeno.
 */
export function confirmacionValida(
  c: Confirmacion | null,
  quien: { organizationId: string; userId: string },
  ahora = Date.now(),
): c is Confirmacion {
  if (!c) return false;
  if (ahora - c.creadaEn > TTL_CONFIRMACION_MS) return false;
  if (c.organizationId !== quien.organizationId) return false;
  if (c.userId !== quien.userId) return false;
  return true;
}
