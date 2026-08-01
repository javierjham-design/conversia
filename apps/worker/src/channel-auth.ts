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
}

/** Error de autenticación del canal (token vencido/revocado — Meta code 190/401). */
export class ChannelAuthError extends Error {
  readonly kind = "channel_auth";
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
    const account = await tx.whatsappAccount.findUnique({ where: { id: number.accountId } });
    if (account?.credentialId) {
      const credential = await tx.integrationCredential.findUnique({ where: { id: account.credentialId } });
      if (credential) {
        try {
          accessToken = decryptCredential(credential.ciphertext);
        } catch {
          /* credencial ilegible → fallback al global */
        }
      }
    }
    return {
      phoneNumberId: number.phoneNumberId,
      accessToken,
      channelConnectionId: number.channelConnectionId ?? opts.channelConnectionId ?? null,
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
