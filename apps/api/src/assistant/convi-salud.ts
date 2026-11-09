import { getAdminPrisma } from "@conversia/database";

/**
 * ¿ESTÁ CONVI RESPONDIENDO? — alarma propia del copiloto.
 *
 * El 2-nov-2026 el Super Admin cambió el proveedor de Convi a OpenAI y, por un nombre de
 * herramienta con ñ, el copiloto empezó a contestar "estoy teniendo un problema para
 * responder" a TODO el mundo. Estuvo así SIETE DÍAS y lo descubrió el dueño mirando la
 * pantalla: `/health/status` decía `ai: {ok:true}` todo ese tiempo, porque ese chequeo solo
 * mira la degradación del router que marca el WORKER — es decir, los bots de WhatsApp.
 * Convi no tenía forma de avisar de nada.
 *
 * Es el mismo patrón que la marca del worker, pero en `platform_settings` en vez de Redis:
 * Convi se usa a ráfagas y una marca con TTL corto se borra sola entre cliente y cliente,
 * que es justo cuando nadie está mirando. La fila se pone al fallar y SE BORRA al primer
 * turno bueno, así que un incidente resuelto no deja la alarma encendida.
 */
export const CONVI_CAIDO_KEY = "assistant:caido";

/** Pasada esta edad la marca ya no se cree: un incidente de hace días no es una caída de hoy. */
export const CONVI_CAIDO_VENTANA_MS = 6 * 60 * 60 * 1000;

export interface ConviCaido {
  desde: number;
  proveedor: string;
  modelo: string;
  error: string;
}

/** Deja constancia de que el proveedor le falló a Convi. Nunca lanza: es telemetría. */
export async function marcarConviCaido(proveedor: string, modelo: string, error: string): Promise<void> {
  try {
    const previo = await leerConviCaido();
    // `desde` se conserva para que el aviso diga cuánto lleva roto, no cuándo fue el último intento.
    const info: ConviCaido = {
      desde: previo?.desde ?? Date.now(),
      proveedor,
      modelo,
      error: error.slice(0, 300),
    };
    const value = JSON.stringify(info);
    await getAdminPrisma().platformSetting.upsert({
      where: { key: CONVI_CAIDO_KEY },
      update: { value },
      create: { key: CONVI_CAIDO_KEY, value },
    });
  } catch {
    /* si no se puede escribir la marca, el turno del cliente NO se cae por eso */
  }
}

/** Convi volvió a responder: se apaga la alarma. */
export async function limpiarConviCaido(): Promise<void> {
  try {
    await getAdminPrisma().platformSetting.deleteMany({ where: { key: CONVI_CAIDO_KEY } });
  } catch {
    /* idem */
  }
}

/** Marca vigente, o null si no hay o si ya es demasiado vieja para creerle. */
export async function leerConviCaido(): Promise<ConviCaido | null> {
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: CONVI_CAIDO_KEY } });
    if (!row) return null;
    const info = JSON.parse(row.value) as ConviCaido;
    if (!info?.desde || Date.now() - info.desde > CONVI_CAIDO_VENTANA_MS) return null;
    return info;
  } catch {
    return null;
  }
}

/** Texto para `/health/status`: dice desde cuándo y con qué, que es lo que uno necesita. */
export function detalleConviCaido(info: ConviCaido, ahora = Date.now()): string {
  const minutos = Math.max(1, Math.round((ahora - info.desde) / 60000));
  const cuanto = minutos >= 120 ? `${Math.round(minutos / 60)} h` : `${minutos} min`;
  return `Convi lleva ${cuanto} sin poder responder [${info.proveedor}/${info.modelo}]: ${info.error}`;
}
