import { getAdminPrisma } from "@conversia/database";
import { getEnv } from "@conversia/config";
import { storageDelWorker } from "./media-store";

/**
 * RETENCIÓN DE MEDIOS GUARDADOS — borra del bucket lo que ya cumplió su plazo.
 *
 * Guardar los medios (D4) resuelve que Meta los borre a los 30 días, pero crea el problema
 * opuesto: guardarlos para siempre es una cuenta que sube sola y nunca baja. El plazo lo fija
 * `MEDIA_RETENTION_DAYS` (365 por defecto).
 *
 * **La fila de `files` NO se borra, se marca.** El mensaje sigue existiendo en el chat, y el
 * panel tiene que poder decir «este archivo ya no está disponible» en vez de mostrar un hueco
 * sin explicación. Es el mismo texto que cuando lo borra Meta, que para el dueño es la misma
 * situación.
 */

/** Cada cuánto se revisa. Una vez al día alcanza: el plazo se mide en meses. */
export const CADA_MS = 24 * 60 * 60 * 1000;

/** Cuántos se borran por pasada, para no bloquear el worker con un barrido enorme. */
export const TOPE_POR_PASADA = 500;

/** ¿Qué archivos ya vencieron? Pura: la fecha de corte sale de los días configurados. */
export function fechaDeCorte(ahora: Date, dias: number): Date {
  return new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
}

export async function barrerMediosVencidos(ahora: Date = new Date()): Promise<{ borrados: number }> {
  const s = storageDelWorker();
  // Sin bucket no hay nada guardado que borrar.
  if (!s) return { borrados: 0 };

  const dias = getEnv().MEDIA_RETENTION_DAYS;
  const corte = fechaDeCorte(ahora, dias);
  const admin = getAdminPrisma();

  // Solo los de MENSAJES: los de conocimiento, marca o exportes tienen su propio ciclo.
  const vencidos = await admin.file.findMany({
    where: { scope: "message", deletedAt: null, createdAt: { lt: corte } },
    select: { id: true, key: true },
    take: TOPE_POR_PASADA,
  });
  if (!vencidos.length) return { borrados: 0 };

  let borrados = 0;
  for (const f of vencidos) {
    // Primero el objeto, después la marca: si el borrado del bucket falla, la fila queda sin
    // marcar y la próxima pasada lo reintenta. Al revés quedaría un objeto pagándose para
    // siempre sin ninguna fila que lo recuerde.
    try {
      if (f.key) await s.del(f.key);
      await admin.file.update({ where: { id: f.id }, data: { deletedAt: ahora, content: null } });
      borrados++;
    } catch (e) {
      console.error(`✖ Retención: no se pudo borrar ${f.key} (${(e as Error).message?.slice(0, 100)})`);
    }
  }
  if (borrados) console.log(`🧹 Retención de medios: ${borrados} archivo(s) de más de ${dias} días`);
  return { borrados };
}

/** Arranca el barrido diario. Devuelve la función para detenerlo. */
export function startMediaRetention(): () => void {
  const tick = () => void barrerMediosVencidos().catch((e) => console.error("✖ Retención de medios:", (e as Error).message));
  // La primera pasada se demora a propósito: al arrancar, el worker tiene cosas más urgentes
  // que hacer que un barrido de limpieza.
  const inicial = setTimeout(tick, 5 * 60_000);
  const timer = setInterval(tick, CADA_MS);
  return () => {
    clearTimeout(inicial);
    clearInterval(timer);
  };
}
