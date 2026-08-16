import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";

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

/** Error de autenticación del canal (token vencido/revocado — Meta code 190/401). */
export class ChannelAuthError extends Error {
  readonly kind = "channel_auth";
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
 * Marca el canal en estado "error" tras un fallo de autenticación con Meta y lo
 * registra en la actividad. El panel muestra el banner "Reautorizar". No lanza
 * (se llama desde bloques catch) y no se reintenta en bucle: el mensaje queda
 * FAILED y el equipo repara el token.
 */
export async function markChannelAuthError(
  organizationId: string,
  channelConnectionId: string | null,
  detail: string,
): Promise<void> {
  try {
    // Alerta por correo SOLO en la transición activo→error (no por cada fallo).
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
        },
      });
    });
    if (wasActive) {
      // import diferido: evita ciclo mailer ↔ channel-auth
      const { enqueueIntegrationAlert } = await import("./mailer.js");
      await enqueueIntegrationAlert(
        organizationId,
        "⚠ WhatsApp requiere reautorización — TuBot",
        "<p>El token del canal de WhatsApp está vencido o fue revocado: los mensajes salientes están fallando.</p><p>Entra a <b>Canales</b> y pulsa <b>Reautorizar con Meta</b>.</p>",
      );
    }
  } catch {
    /* best-effort */
  }
}
