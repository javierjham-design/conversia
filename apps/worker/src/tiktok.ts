import { createHash } from "node:crypto";
import { withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";

/**
 * TIKTOK EVENTS API — las conversiones que pasan en WhatsApp vuelven a TikTok.
 *
 * Para qué sirve: un emprendimiento que vende por TikTok paga anuncios que llevan a WhatsApp.
 * TikTok ve el clic, pero NO ve la venta —esa ocurre en la conversación—, así que optimiza a
 * ciegas: reparte el presupuesto hacia los videos que generan clics, no hacia los que generan
 * clientes. Mandarle el evento de vuelta es lo que le permite aprender.
 *
 * Diferencia importante con Meta, para no prometer de más: WhatsApp entrega un `ctwa_clid` que
 * identifica el anuncio exacto del que vino la persona. **TikTok no tiene equivalente** cuando
 * el tráfico pasa por WhatsApp: el clic se pierde al salir de la app. Así que el calce lo hace
 * TikTok por los datos de la persona (teléfono/correo hasheados), que es más débil. Vale igual
 * —es lo que usa toda la industria para conversiones offline— pero no es atribución exacta.
 *
 * Por eso el `event_source` es **`crm`** y no `web`: nuestros eventos no ocurren en una página.
 *
 * Contrato (verificado contra implementaciones en producción; el portal de TikTok no sirve su
 * documentación por HTTP, así que la pantalla de la integración trae un botón **Probar** que
 * hace una llamada REAL antes de guardar):
 *
 *   POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 *   Access-Token: <token del tenant>
 *   { event_source, event_source_id, data: [ { event, event_time, event_id, user, properties } ] }
 *
 * LA TRAMPA: TikTok responde **HTTP 200 con `code` distinto de 0** cuando rechaza el evento
 * (token inválido, pixel que no existe, evento mal armado). Mirar solo `res.ok` da por enviado
 * lo que nunca se registró, y el síntoma sería un panel que dice «enviado» mientras TikTok
 * sigue optimizando a ciegas. Lo encierra `tiktok.test.ts`.
 */

const URL_EVENTOS = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/** Eventos estándar de TikTok que tienen sentido para una conversación de WhatsApp. */
export const EVENTOS_TIKTOK = [
  "Contact",
  "SubmitForm",
  "Lead",
  "CompleteRegistration",
  "Subscribe",
  "PlaceAnOrder",
  "CompletePayment",
] as const;

export interface EventoTiktok {
  /** Nombre del evento (estándar de TikTok, o uno propio del anunciante). */
  eventName: string;
  value?: number | null;
  currency?: string | null;
  /** Teléfono del contacto, en cualquier formato: se normaliza a E.164 antes de hashear. */
  phone?: string | null;
  email?: string | null;
  /** Identificador propio y estable del contacto (nuestro `contactId`). */
  externalId?: string | null;
  /**
   * Clave de DEDUPLICACIÓN. Tiene que ser la MISMA en todos los reintentos del mismo hecho:
   * la cola reintenta, y un `event_id` nuevo por intento convierte un timeout (que igual pudo
   * haber llegado) en una conversión contada dos veces. Eso no solo ensucia el reporte: le
   * enseña a TikTok que un anuncio rinde el doble de lo que rinde.
   */
  eventId: string;
  /**
   * Momento del hecho. Por omisión, ahora.
   *
   * `Date` **o texto ISO**: este objeto viaja por la cola como JSON, así que un `Date` que se
   * encola llega al otro lado convertido en `string`. Tipado solo como `Date`, el código
   * compila igual y revienta en producción con «occurredAt.getTime is not a function» dentro
   * de un job, que es donde menos se mira.
   */
  occurredAt?: Date | string;
}

/** Acepta `Date`, texto ISO o nada, y nunca devuelve una fecha inválida. */
export function momentoDelEvento(valor: Date | string | undefined, ahora: Date): Date {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? ahora : valor;
  if (typeof valor === "string" && valor.trim()) {
    const d = new Date(valor);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return ahora;
}

/**
 * SHA-256 en hexadecimal, que es lo que TikTok espera. Las reglas de normalización NO son
 * decorativas: un teléfono hasheado con otro formato produce un hash distinto y entonces no
 * calza con NADIE — el evento se acepta, se reporta como enviado y no sirve para nada. Es el
 * fallo más silencioso de toda esta integración.
 */
function sha256Hex(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

/** Correo: minúsculas y sin espacios alrededor. */
export function hashCorreo(email: string): string {
  return sha256Hex(email.trim().toLowerCase());
}

/**
 * Teléfono: E.164 — `+` y SOLO dígitos, hasta 15 caracteres. `+56 9 1234 5678`,
 * `56912345678` y `(569) 1234-5678` tienen que producir el MISMO hash o el calce se pierde.
 */
export function hashTelefono(phone: string): string {
  return sha256Hex(`+${phone.replace(/[^0-9]/g, "")}`.slice(0, 15));
}

/** Identificador propio: minúsculas y sin espacios alrededor. */
export function hashIdPropio(id: string): string {
  return sha256Hex(id.trim().toLowerCase());
}

export interface ConfigTiktok {
  /** Pixel code (origen web) o ID del conjunto de eventos offline/CRM. */
  eventSourceId: string;
  eventSource: string;
  accessToken: string;
}

/** Lee la conexión del tenant. `null` = no configurada (no hay nada que reintentar). */
export async function getTiktokConfig(organizationId: string): Promise<ConfigTiktok | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider: "tiktok", status: { not: "inactive" } } });
    if (!conn) return null;
    const cfg = (conn.config as Record<string, any>) ?? {};
    if (!cfg.eventSourceId || !conn.credentialId) return null;
    const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
    if (!cred) return null;
    try {
      return {
        eventSourceId: String(cfg.eventSourceId),
        eventSource: String(cfg.eventSource || "crm"),
        accessToken: decryptCredential(cred.ciphertext),
      };
    } catch {
      return null;
    }
  });
}

/** El cuerpo que se le manda a TikTok. Pura, para poder comprobarla sin red. */
export function armarPayloadTiktok(
  config: Pick<ConfigTiktok, "eventSourceId" | "eventSource">,
  evento: EventoTiktok,
  ahora: Date,
) {
  // `user` lleva ARREGLOS de hashes (TikTok acepta varios identificadores por persona).
  const user: Record<string, unknown> = {};
  if (evento.phone) user.phone = [hashTelefono(evento.phone)];
  if (evento.email) user.email = [hashCorreo(evento.email)];
  if (evento.externalId) user.external_id = [hashIdPropio(evento.externalId)];

  const properties: Record<string, unknown> = {};
  if (evento.value != null && Number.isFinite(Number(evento.value))) {
    properties.value = Number(evento.value);
    properties.currency = evento.currency || "CLP";
  }

  return {
    event_source: config.eventSource,
    event_source_id: config.eventSourceId,
    data: [
      {
        event: evento.eventName,
        // En SEGUNDOS, no milisegundos: en milisegundos TikTok lo lee como el año 56.000 y
        // descarta el evento por estar fuera de la ventana aceptada.
        event_time: Math.floor(momentoDelEvento(evento.occurredAt, ahora).getTime() / 1000),
        event_id: evento.eventId,
        user,
        properties,
        limited_data_use: false,
      },
    ],
  };
}

/**
 * ¿La respuesta de TikTok dice que SÍ se registró el evento?
 *
 * `code: 0` es el único éxito. TikTok devuelve 200 con `code` distinto de 0 para los errores
 * de lógica, así que esta función es la que evita dar por bueno lo que se rechazó.
 */
export function leerRespuestaTiktok(httpStatus: number, cuerpo: unknown): { ok: boolean; detalle: string } {
  const body = (cuerpo ?? {}) as { code?: unknown; message?: unknown; request_id?: unknown };
  const code = typeof body.code === "number" ? body.code : typeof body.code === "string" ? Number(body.code) : undefined;
  const message = typeof body.message === "string" && body.message ? body.message : "";

  if (httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, detalle: `TikTok respondió HTTP ${httpStatus}${message ? `: ${message}` : ""}` };
  }
  // 200 sin `code` legible: no se puede afirmar que se registró. Se trata como error para no
  // reportar un éxito inventado.
  if (code === undefined) {
    return { ok: false, detalle: "TikTok respondió 200 pero sin el campo `code`; no se puede confirmar el envío" };
  }
  if (code !== 0) {
    return { ok: false, detalle: `TikTok rechazó el evento (code ${code})${message ? `: ${message}` : ""}` };
  }
  return { ok: true, detalle: message || "Evento registrado por TikTok" };
}

/**
 * Manda un evento a TikTok. Lanza en error → la cola reintenta con backoff.
 * Sin configuración NO lanza: no hay nada que reintentar, solo se deja constancia honesta.
 */
export async function sendTiktokEvent(organizationId: string, evento: EventoTiktok): Promise<void> {
  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "tiktok",
          type: status === "ok" ? "tiktok.sent" : "tiktok.error",
          status,
          message,
        },
      }),
    ).catch(() => undefined);

  const config = await getTiktokConfig(organizationId);
  if (!config) {
    await log("error", `Evento TikTok «${evento.eventName}» no enviado: la integración no está configurada`);
    return;
  }
  if (!evento.eventName?.trim()) {
    await log("error", "Evento TikTok sin nombre: el paso del flujo no tiene evento elegido");
    return; // un nombre vacío lo rechaza TikTok siempre; reintentarlo no lo arregla
  }
  // Sin NINGÚN identificador, TikTok no puede calzar el evento con nadie. Se avisa y no se
  // manda: un evento que no calza no mejora la optimización y ensucia el reporte.
  if (!evento.phone && !evento.email && !evento.externalId) {
    await log("error", `Evento TikTok «${evento.eventName}» no enviado: el contacto no tiene teléfono ni correo`);
    return;
  }

  const payload = armarPayloadTiktok(config, evento, new Date());
  let httpStatus = 0;
  let cuerpo: unknown = null;
  try {
    const res = await fetch(URL_EVENTOS, {
      method: "POST",
      headers: { "Access-Token": config.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = res.status;
    cuerpo = await res.json().catch(() => null);
  } catch (err) {
    const detalle = `No se pudo contactar a TikTok: ${(err as Error).message}`;
    await log("error", `Evento TikTok «${evento.eventName}» — ${detalle}`);
    throw new Error(detalle); // red caída → la cola reintenta
  }

  const { ok, detalle } = leerRespuestaTiktok(httpStatus, cuerpo);
  await log(ok ? "ok" : "error", `Evento TikTok «${evento.eventName}» — ${detalle}`);
  if (!ok) throw new Error(detalle);
}
