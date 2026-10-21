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
    let number = opts.phoneNumberId
      ? await tx.whatsappPhoneNumber.findFirst({ where: { phoneNumberId: opts.phoneNumberId } })
      : null;
    if (!number && opts.channelConnectionId) {
      number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: opts.channelConnectionId } });
    }
    if (!number) {
      // Canal mock o tenant sin número: id sintético que el MockProvider imprime.
      if (opts.channelConnectionId) {
        const channel = await tx.channelConnection.findUnique({ where: { id: opts.channelConnectionId } });
        if (channel?.type === "MOCK") {
          const org = await tx.organization.findUnique({ where: { id: organizationId } });
          return { phoneNumberId: `mock:${org?.slug ?? organizationId}`, accessToken: null, channelConnectionId: opts.channelConnectionId };
        }
      }
      number = await tx.whatsappPhoneNumber.findFirst({ where: { status: "active" } });
      if (!number) {
        const org = await tx.organization.findUnique({ where: { id: organizationId } });
        return { phoneNumberId: `mock:${org?.slug ?? organizationId}`, accessToken: null, channelConnectionId: opts.channelConnectionId ?? null };
      }
    }

    let accessToken: string | null = env.META_ACCESS_TOKEN || null;
    let tokenSource: ChannelAuth["tokenSource"] = accessToken ? "global-no-account" : "none";
    const account = await tx.whatsappAccount.findUnique({ where: { id: number.accountId } });
    if (account?.credentialId) {
      const credential = await tx.integrationCredential.findUnique({ where: { id: account.credentialId } });
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
