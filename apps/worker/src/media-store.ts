import { crearStorage, type Storage } from "@conversia/storage";
import { getEnv } from "@conversia/config";

/**
 * El almacenamiento del worker, resuelto UNA vez por proceso.
 *
 * Igual que en la API: si no hay bucket configurado devuelve null y todo sigue como siempre
 * —los medios se bajan de Meta cuando alguien los abre— sin que nada falle.
 */
let cache: Storage | null | undefined;

export function storageDelWorker(): Storage | null {
  if (cache === undefined) cache = crearStorage(getEnv());
  return cache;
}

/** Solo para tests. */
export function _ponerStorageDelWorker(s: Storage | null | undefined): void {
  cache = s;
}
