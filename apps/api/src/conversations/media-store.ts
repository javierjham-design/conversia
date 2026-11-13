import type { TenantTx } from "@conversia/database";
import { crearStorage, guardarMedioDeMensaje, type KindDeMedio, type Storage } from "@conversia/storage";

export type { KindDeMedio };
import { getEnv } from "@conversia/config";

/**
 * GUARDAR AL PRIMER USO — el medio deja de depender de que Meta lo conserve.
 *
 * Decisión del dueño: **no se guarda todo al ingresar, se guarda la primera vez que alguien
 * lo abre.** La diferencia es plata: en una cuenta con mucho tráfico la mayoría de las fotos
 * no las mira nadie, y pagar almacenamiento por ellas es tirar el dinero. La excepción son
 * los audios con transcripción y las imágenes que ve el agente: el worker YA los descarga
 * para su trabajo, así que guardarlos ahí no cuesta una descarga extra (eso vive en el
 * worker, no acá).
 *
 * Si no hay bucket configurado, estas funciones no hacen nada y todo sigue exactamente como
 * antes: bajando de Meta en cada vista. Por eso nada de esto es un requisito para operar.
 */

let cacheStorage: Storage | null | undefined;

/** El storage del proceso, o null si no está configurado. Se resuelve UNA vez. */
export function storage(): Storage | null {
  if (cacheStorage === undefined) cacheStorage = crearStorage(getEnv());
  return cacheStorage;
}

/** Solo para tests: inyectar un doble y volver atrás. */
export function _ponerStorage(s: Storage | null | undefined): void {
  cacheStorage = s;
}

/**
 * ¿Ya lo tenemos guardado? Devuelve el archivo o null.
 *
 * Un `File` con `deletedAt` cuenta como NO disponible: el barrido de retención ya borró el
 * objeto del bucket, y pedirlo otra vez sería un viaje perdido.
 */
export async function leerGuardado(
  tx: TenantTx,
  messageId: string,
  kind: KindDeMedio,
): Promise<{ body: Buffer; mime: string } | null> {
  const s = storage();
  if (!s) return null;
  const adjunto = await tx.messageAttachment.findFirst({ where: { messageId, kind } });
  if (!adjunto?.fileId) return null;
  const file = await tx.file.findFirst({ where: { id: adjunto.fileId, deletedAt: null } });
  if (!file?.key) return null;
  const obj = await s.get(file.key).catch(() => null);
  if (!obj) return null;
  return { body: obj.body, mime: file.mime ?? obj.mime };
}

/**
 * Guarda un medio recién bajado de Meta. La escritura vive en `@conversia/storage`
 * (`guardarMedioDeMensaje`), compartida con el worker: son dos momentos distintos —acá el
 * primer uso, allá el ingreso— pero lo que se escribe es idéntico.
 */
export async function guardarMedio(
  tx: TenantTx,
  organizationId: string,
  messageId: string,
  kind: KindDeMedio,
  body: Buffer,
  mime: string,
  nombre?: string | null,
): Promise<void> {
  await guardarMedioDeMensaje(storage(), tx as never, { organizationId, messageId, kind, body, mime, nombre });
}
