import { getEnv } from "@conversia/config";
import { getAdminPrisma, raiseException, resolveException, withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";
import { opsAlert } from "./ops-alert.js";

/**
 * Resolución de autenticación de envío POR CANAL: cada WABA conectada tiene su
 * token cifrado (integration_credentials); el global META_ACCESS_TOKEN queda
 * solo como fallback (canal propio de la plataforma / instalaciones antiguas).
 * Esto es lo que permite responder desde las WABAs de los clientes (Tech
 * Provider) y no solo desde la de la plataforma.
 */

export interface ChannelAuth {
  phoneNumberId: string;
  accessToken: string | null;
  channelConnectionId: string | null;
  /**
   * De dónde salió el token efectivo — para diagnosticar el #133010 "misterioso":
   * si el número tiene credencial propia pero terminamos usando el GLOBAL, es que
   * el worker no pudo descifrarla (típicamente CREDENTIALS_ENCRYPTION_KEY distinta
   * a la del API) y por eso Meta rechaza el envío (el global no puede operar la
   * WABA del tenant / un número de prueba).
   */
  tokenSource?: "channel" | "global-no-account" | "global-no-credential" | "global-decrypt-failed" | "none";
}

/** Mensaje claro (ops) para un token de WhatsApp inválido: qué pasó + qué hacer. */
export const TOKEN_INVALID_FAIL_TEXT =
  "Token de WhatsApp inválido (Meta 190) — reemplaza el token en Railway (api y worker) y reautoriza en Canales.";

/** Error de autenticación del canal (token vencido/revocado — Meta code 190/401). */
export class ChannelAuthError extends Error {
  readonly kind = "channel_auth";
  /** Texto claro para marcar el mensaje FAILED (en vez del error crudo de Meta). */
  readonly userMessage: string;
  constructor(message: string, userMessage?: string) {
    super(message);
    this.userMessage = userMessage ?? TOKEN_INVALID_FAIL_TEXT;
  }
}

/**
 * Error de CONFIGURACIÓN del canal en Meta (no de token): el número necesita algo
 * del lado de Meta antes de poder enviar (nombre para mostrar, registro, pago…).
 * Reintentar no lo arregla; se marca el canal y se muestra un aviso claro.
 */
export class ChannelConfigError extends Error {
  readonly kind = "channel_config";
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
  }
}

/**
 * §4.5 — El mensaje NO se puede entregar A ESTE DESTINATARIO, y reintentar no lo arregla.
 *
 * Es distinto de `ChannelConfigError`: ahí el problema es del CANAL (falta el nombre para
 * mostrar, el número no está registrado…) y corresponde marcarlo en error. Acá el canal
 * está perfecto; lo que no se puede es este mensaje a este número. Marcar el canal por
 * esto dejaría al cliente viendo "revisa tu WhatsApp" porque UN contacto cerró su ventana
 * de 24 h o tiene el número dado de baja.
 */
export class MessageUndeliverableError extends Error {
  readonly kind = "message_undeliverable";
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
  }
}

/**
 * §4.5 — Meta nos está limitando (130429 throughput de la cuenta, 131056 el par
 * número→destinatario). Reintentar enseguida empeora el problema: hay que esperar.
 */
export class MetaRateLimitError extends Error {
  readonly kind = "meta_rate_limit";
  constructor(
    message: string,
    /** Cuánto esperar antes de volver a intentar. */
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/**
 * §4.5 — Clasifica un error de ENVÍO de Meta en lo que hay que hacer con él.
 *
 * Antes, todo lo que no fuera 190 (token) ni un 400 de configuración entraba al reintento
 * genérico de BullMQ. Eso significa dos cosas malas: una ventana de 24 h cerrada (131047)
 * o un número que no recibe (131026) se reintentaban varias veces para terminar igual, con
 * el error CRUDO de Meta guardado en el mensaje; y un rate limit (130429/131056) se
 * reintentaba rápido, que es exactamente lo que no hay que hacer cuando te están limitando.
 */
export function classifyMetaSendError(
  status: number,
  body: unknown,
  rawText: string,
): MessageUndeliverableError | MetaRateLimitError | null {
  const err = (body as { error?: { code?: number; message?: string } } | null)?.error;
  const code = err?.code ?? (/"code":(\d+)/.exec(rawText)?.[1] ? Number(/"code":(\d+)/.exec(rawText)![1]) : undefined);
  const detalle = (err?.message ?? rawText).slice(0, 200);

  // TERMINALES para este mensaje (el canal está bien).
  if (code === 131047) {
    return new MessageUndeliverableError(
      `Meta 131047 (ventana de 24 h cerrada): ${detalle}`,
      "Pasaron más de 24 h desde el último mensaje de este contacto, así que WhatsApp no permite escribirle texto libre. Usa una plantilla aprobada para reabrir la conversación.",
    );
  }
  if (code === 131026) {
    return new MessageUndeliverableError(
      `Meta 131026 (mensaje no entregable): ${detalle}`,
      "WhatsApp no puede entregar a este número: puede no tener WhatsApp, estar dado de baja o no aceptar mensajes de empresas. Confirma el número con el contacto.",
    );
  }

  // LIMITACIÓN: esperar, no insistir.
  if (code === 130429 || code === 131056 || status === 429) {
    // 131056 es por PAR (nuestro número → ese destinatario) y se suelta rápido; 130429 es
    // de toda la cuenta y necesita más aire.
    const retryAfterMs = code === 131056 ? 60_000 : 15 * 60_000;
    return new MetaRateLimitError(`Meta ${code ?? status} (rate limit): ${detalle}`, retryAfterMs);
  }
  return null;
}

/** Traduce un error 400 de Meta a un aviso claro para el tenant (o null si no aplica). */
export function channelConfigNotice(text: string): string | null {
  if (text.includes('"code":131037') || text.toLowerCase().includes("display name"))
    return "Tu número de WhatsApp necesita que Meta apruebe su Nombre para mostrar antes de poder enviar mensajes. Configúralo en WhatsApp Manager → tu número → Nombre para mostrar.";
  if (text.includes('"code":131045') || text.includes('"code":133010'))
    return "Tu número de WhatsApp no está registrado en Cloud API para el token con el que se está enviando. Si es un número de PRUEBA, solo envía con su token de prueba (repégalo en Canales → Editar). Si es un número real, revisa que el token del canal esté vigente y que el número tenga completado su registro.";
  if (text.includes('"code":131042'))
    return "Tu cuenta de WhatsApp Business tiene un problema de método de pago o elegibilidad en Meta. Revísalo en Meta Business Manager.";
  if (text.includes('"code":131031'))
    return "Tu cuenta de WhatsApp Business está bloqueada o restringida en Meta. Revísalo en Meta Business Manager.";
  return null;
}

/**
 * Aviso de configuración de canal en Meta. NO cambia el estado del canal (el token
 * y la conexión están OK): solo registra una incidencia clara (campana) + alerta,
 * deduplicada para no spamear. El mensaje fallido ya muestra el motivo claro.
 */
export async function markChannelConfigError(
  organizationId: string,
  _channelConnectionId: string | null,
  userMessage: string,
): Promise<void> {
  try {
    // Dedupe: una incidencia de config por día como máximo.
    const recent = await withTenant(organizationId, (tx) =>
      tx.integrationEvent.findFirst({
        where: { provider: "whatsapp", type: "channel.config_error", createdAt: { gt: new Date(Date.now() - 20 * 3600 * 1000) } },
        select: { id: true },
      }),
    );
    if (recent) return;
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "whatsapp", type: "channel.config_error", status: "error", message: userMessage.slice(0, 300) },
      }),
    );
    const { enqueueIntegrationAlert } = await import("./mailer.js");
    await enqueueIntegrationAlert(organizationId, "⚠ WhatsApp requiere configuración en Meta — TuBot", `<p>${userMessage}</p><p>Los mensajes salientes están fallando hasta resolverlo (la conexión del canal está bien).</p>`);
  } catch {
    /* best-effort */
  }
}

export async function resolveChannelAuth(
  organizationId: string,
  opts: { channelConnectionId?: string | null; phoneNumberId?: string | null },
): Promise<ChannelAuth> {
  const env = getEnv();
  return withTenant(organizationId, async (tx) => {
    // AISLAMIENTO: todo número/canal debe ser de ESTA organización (filtro explícito,
    // además de RLS). Un número de otra org haría que el mensaje saliera desde el
    // WhatsApp de otro cliente.
    let number = opts.phoneNumberId
      ? await tx.whatsappPhoneNumber.findFirst({ where: { organizationId, phoneNumberId: opts.phoneNumberId } })
      : null;
    if (!number && opts.channelConnectionId) {
      number = await tx.whatsappPhoneNumber.findFirst({ where: { organizationId, channelConnectionId: opts.channelConnectionId } });
    }
    if (!number) {
      // Canal mock o tenant sin número: id sintético que el MockProvider imprime.
      if (opts.channelConnectionId) {
        const channel = await tx.channelConnection.findFirst({ where: { id: opts.channelConnectionId, organizationId } });
        if (channel?.type === "MOCK") {
          const org = await tx.organization.findUnique({ where: { id: organizationId } });
          return { phoneNumberId: `mock:${org?.slug ?? organizationId}`, accessToken: null, channelConnectionId: opts.channelConnectionId };
        }
      }
      // Respaldo: el primer número activo DE ESTA ORGANIZACIÓN (antes era "el primer
      // número activo" sin filtrar → podía ser el de otro cliente).
      number = await tx.whatsappPhoneNumber.findFirst({ where: { organizationId, status: "active" } });
      if (!number) {
        // Sin número propio: con el proveedor mock se sigue con el id sintético (E2E
        // sin credenciales de Meta); con Meta real se FALLA con un motivo claro — nunca
        // se envía por el número de otra organización ni se sigue en silencio.
        if (env.WHATSAPP_PROVIDER !== "meta") {
          const org = await tx.organization.findUnique({ where: { id: organizationId } });
          return { phoneNumberId: `mock:${org?.slug ?? organizationId}`, accessToken: null, channelConnectionId: opts.channelConnectionId ?? null };
        }
        throw new ChannelConfigError(
          `resolveChannelAuth: la organización ${organizationId} no tiene un canal de WhatsApp activo propio`,
          "La organización no tiene un canal de WhatsApp activo propio: conecta tu número en Canales antes de enviar mensajes.",
        );
      }
    }

    let accessToken: string | null = env.META_ACCESS_TOKEN || null;
    let tokenSource: ChannelAuth["tokenSource"] = accessToken ? "global-no-account" : "none";
    const account = await tx.whatsappAccount.findFirst({ where: { id: number.accountId, organizationId } });
    if (account?.credentialId) {
      const credential = await tx.integrationCredential.findFirst({ where: { id: account.credentialId, organizationId } });
      if (credential) {
        try {
          accessToken = decryptCredential(credential.ciphertext);
          tokenSource = "channel";
        } catch {
          // Credencial ilegible → fallback al global. NO es normal: suele ser que
          // el worker tiene otra CREDENTIALS_ENCRYPTION_KEY que el API que la cifró.
          tokenSource = "global-decrypt-failed";
        }
      } else {
        tokenSource = "global-no-credential";
      }
    } else if (account) {
      tokenSource = "global-no-credential";
    }
    return {
      phoneNumberId: number.phoneNumberId,
      accessToken,
      channelConnectionId: number.channelConnectionId ?? opts.channelConnectionId ?? null,
      tokenSource,
    };
  });
}

/**
 * §4.2 — ¿Se permite ENVIAR con el token GLOBAL de la plataforma en vez del del canal?
 *
 * Enviar con el token global significa responderle al cliente de alguien con credenciales
 * que no son suyas: o Meta lo rechaza (#133010) o sale por un número que el cliente no
 * conectó. La auditoría pide cerrarlo salvo para Conversia (que ofrece número llave en
 * mano de la plataforma) o cuentas marcadas como de plataforma.
 *
 * Se cierra EN DOS PASOS a propósito. Desde el worker no hay forma de saber si alguna
 * cuenta de TuBot depende hoy del token global, y cortarle los envíos a ciegas a un bot que
 * atiende 24/7 sería justo el incidente que esta etapa quiere evitar. Así que:
 *  1. Siempre deja rastro VISIBLE (una excepción de plataforma por canal y día) → el dueño
 *     ve en la consola si alguien está usando el global, y quién.
 *  2. Bloquea solo con `WA_GLOBAL_TOKEN_FALLBACK=block`, cuando él lo decida.
 *
 * Conversia nunca se bloquea: ahí el token de plataforma es parte del producto.
 */
export async function decidirFallbackGlobal(
  organizationId: string,
  auth: Pick<ChannelAuth, "tokenSource" | "phoneNumberId" | "channelConnectionId">,
): Promise<"ok" | "block"> {
  // Token propio del canal (el caso normal) o canal mock: nada que decidir.
  if (!auth.tokenSource || auth.tokenSource === "channel" || auth.tokenSource === "none") return "ok";
  try {
    const admin = getAdminPrisma();
    const org = await admin.organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    const brand = (org?.brand ?? "tubot").toLowerCase();
    // Visibilidad SIEMPRE, con dedupe por canal y día: una fila, no una por mensaje.
    const dia = new Date().toISOString().slice(0, 10);
    await raiseException(admin, {
      organizationId,
      type: "token_global_en_uso",
      title: `Envío con el token GLOBAL de la plataforma (${auth.tokenSource})`,
      severity: "warning",
      detail: `El canal ${auth.channelConnectionId ?? "?"} (número ${auth.phoneNumberId}) está enviando con el token de la plataforma, no con el suyo. Motivo: ${auth.tokenSource}. Reautoriza WhatsApp en ese canal.`,
      dedupeKey: `token-global:${auth.channelConnectionId ?? auth.phoneNumberId}:${dia}`,
    }).catch(() => undefined);
    if (brand === "conversia") return "ok"; // número de plataforma: es parte del producto
    return getEnv().WA_GLOBAL_TOKEN_FALLBACK === "block" ? "block" : "ok";
  } catch {
    return "ok"; // no poder decidir no puede dejar al bot mudo
  }
}

/**
 * HANDLER ÚNICO de "token de WhatsApp muerto" (Meta 190/401), tanto desde el ENVÍO (fail-fast)
 * como desde el CHEQUEO ACTIVO periódico. Hace que una caída JAMÁS sea silenciosa:
 *  - marca el canal en estado "error" (el panel muestra el banner "Reautorizar");
 *  - registra la incidencia en la actividad del tenant (`integration_events`);
 *  - levanta una EXCEPCIÓN de plataforma `token_invalido` CRÍTICA (dedupe por canal) →
 *    visible en la consola del super admin;
 *  - en la transición activo→error: correo al tenant + ALERTA al super admin
 *    (OPS_ALERT_WEBHOOK_URL → BetterStack: correo + push).
 * No lanza (se llama desde catch y desde el scheduler). Idempotente: no spamea.
 */
export async function markChannelAuthError(
  organizationId: string,
  channelConnectionId: string | null,
  detail: string,
  meta?: { phone?: string | null; source?: "send" | "health" },
): Promise<void> {
  try {
    // Alerta (correo + super admin) SOLO en la transición activo→error (no por cada fallo).
    let wasActive = false;
    await withTenant(organizationId, async (tx) => {
      if (channelConnectionId) {
        const prev = await tx.channelConnection.findUnique({ where: { id: channelConnectionId }, select: { status: true } });
        wasActive = prev?.status === "active";
        await tx.channelConnection.update({ where: { id: channelConnectionId }, data: { status: "error" } });
      }
      await tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "whatsapp",
          type: "channel.auth_error",
          status: "error",
          message: `Token del canal inválido o vencido — reautoriza WhatsApp en Canales. Detalle: ${detail.slice(0, 300)}`,
          payload: { source: meta?.source ?? "send", phone: meta?.phone ?? null, channelConnectionId },
        },
      });
    });

    // Excepción de plataforma CRÍTICA (dedupe por token/canal → una por token caído, no por minuto).
    const dedupeKey = channelConnectionId ?? `${organizationId}:wa-token`;
    await raiseException(getAdminPrisma(), {
      organizationId,
      type: "token_invalido",
      severity: "critical",
      title: "Token de WhatsApp inválido",
      detail: `${meta?.phone ? `Número ${meta.phone}. ` : ""}El token de envío de WhatsApp fue rechazado por Meta (190/401)${meta?.source === "health" ? " — detectado por el chequeo activo (sin tráfico)" : " — detectado al enviar"}. Reemplázalo en Railway (api y worker). Detalle: ${detail.slice(0, 200)}`,
      dedupeKey,
    });

    if (wasActive) {
      // import diferido: evita ciclo mailer ↔ channel-auth
      const { enqueueIntegrationAlert } = await import("./mailer.js");
      await enqueueIntegrationAlert(
        organizationId,
        "⚠ WhatsApp requiere reautorización — TuBot",
        "<p>El token del canal de WhatsApp está vencido o fue revocado: los mensajes salientes están fallando.</p><p>Entra a <b>Canales</b> y pulsa <b>Reautorizar con Meta</b>.</p>",
      );
      await opsAlert({
        summary: "WhatsApp token inválido (190)",
        description: `Org ${organizationId}${meta?.phone ? ` · ${meta.phone}` : ""}: token de WhatsApp rechazado por Meta (190/401). Los envíos están fallando. Reemplazar el token en Railway (api y worker).`,
        severity: "critical",
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Contraparte: el token de un canal volvió a responder 200. Reactiva el canal, registra el
 * evento de recuperación y RESUELVE la excepción `token_invalido`. La llama el chequeo activo.
 */
export async function markChannelRecovered(organizationId: string, channelConnectionId: string | null): Promise<void> {
  try {
    let wasError = false;
    await withTenant(organizationId, async (tx) => {
      if (channelConnectionId) {
        const prev = await tx.channelConnection.findUnique({ where: { id: channelConnectionId }, select: { status: true } });
        wasError = prev?.status === "error";
        if (wasError) await tx.channelConnection.update({ where: { id: channelConnectionId }, data: { status: "active" } });
      }
      if (wasError) {
        await tx.integrationEvent.create({
          data: { organizationId, provider: "whatsapp", type: "channel.recovered", status: "ok", message: "El token de WhatsApp volvió a responder: canal reactivado." },
        });
      }
    });
    const dedupeKey = channelConnectionId ?? `${organizationId}:wa-token`;
    const closed = await resolveException(getAdminPrisma(), { organizationId, type: "token_invalido", dedupeKey, resolution: "El token de WhatsApp volvió a responder (chequeo activo)." });
    if ((wasError || closed > 0)) {
      await opsAlert({ summary: "WhatsApp token recuperado", description: `Org ${organizationId}: el token de WhatsApp volvió a responder; canal reactivado.`, severity: "info" });
    }
  } catch {
    /* best-effort */
  }
}
