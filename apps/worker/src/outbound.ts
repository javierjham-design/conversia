import { withTenant } from "@conversia/database";
import type { OutboundJob } from "@conversia/types";
import { ChannelAuthError, ChannelConfigError, markChannelAuthError, markChannelConfigError, resolveChannelAuth } from "./channel-auth";
import { getChannelProvider } from "./channel-providers";
import { renderTemplateBody, resolveTemplateParams } from "./template-params";
import { chargeTemplateSend } from "./messaging-guard";

/** Envía mensajes salientes creados desde el panel (autor humano). */
export async function processOutbound(job: OutboundJob): Promise<void> {
  const { organizationId, messageId } = job;

  const data = await withTenant(organizationId, async (tx) => {
    const message = await tx.message.findUnique({ where: { id: messageId } });
    if (!message || message.status !== "PENDING") return null;
    const conversation = await tx.conversation.findUnique({
      where: { id: message.conversationId },
      include: { contact: true },
    });
    if (!conversation) return null;
    return { message, phone: conversation.contact.phone, channelConnectionId: conversation.channelConnectionId, conversationId: conversation.id };
  });

  if (!data) return;

  // Contacto sin teléfono → canal de redes (Messenger/IG): envío por página.
  if (!data.phone) {
    const { trySendMessagingReply } = await import("./messaging-send.js");
    const handled = await trySendMessagingReply(organizationId, data.conversationId, data.message.id, data.message.body ?? "");
    if (!handled) {
      await withTenant(organizationId, (tx) =>
        tx.message.update({ where: { id: data.message.id }, data: { status: "FAILED", error: "Contacto sin teléfono ni canal de mensajería" } }),
      );
    }
    const { publishRealtime } = await import("./realtime.js");
    await publishRealtime(organizationId, { type: "message.updated", conversationId: data.conversationId });
    return;
  }
  const auth = await resolveChannelAuth(organizationId, { channelConnectionId: data.channelConnectionId });

  // Plantilla HSM (fuera de la ventana de 24 h): parámetros resueltos con los
  // datos reales del contacto según el mapeo posición→campo de la plantilla.
  let outbound: import("@conversia/types").OutboundMessage;
  let templateCategory: string | null = null;
  if (data.message.type === "TEMPLATE") {
    const payload = (data.message.payload as Record<string, any>) ?? {};
    const template = await withTenant(organizationId, (tx) =>
      tx.whatsappTemplate.findUnique({ where: { id: String(payload.templateId ?? "") } }),
    );
    if (!template) {
      await withTenant(organizationId, (tx) =>
        tx.message.update({ where: { id: data.message.id }, data: { status: "FAILED", error: "Plantilla no encontrada" } }),
      );
      return;
    }
    const body = (template.body as Record<string, any>) ?? {};
    const fields: string[] = Array.isArray(body.variableFields) ? body.variableFields : [];
    const conversation = await withTenant(organizationId, (tx) =>
      tx.conversation.findUnique({ where: { id: data.message.conversationId }, select: { contactId: true } }),
    );
    const params = await resolveTemplateParams(organizationId, conversation?.contactId ?? null, fields);
    const rendered = renderTemplateBody(body.components ?? [], params);
    templateCategory = template.category;
    await withTenant(organizationId, (tx) =>
      tx.message.update({ where: { id: data.message.id }, data: { body: rendered || data.message.body } }),
    );
    outbound = {
      to: data.phone,
      type: "template",
      templateName: template.name,
      templateLanguage: template.language,
      templateParams: params,
    };
  } else if ((data.message.type === "IMAGE" || data.message.type === "DOCUMENT") && (data.message.payload as any)?.mediaId) {
    // Adjunto subido desde el panel (media id de Meta; caption opcional).
    const payload = data.message.payload as Record<string, any>;
    outbound = {
      to: data.phone,
      type: data.message.type === "IMAGE" ? "image" : "document",
      mediaId: String(payload.mediaId),
      text: payload.caption ?? undefined,
      filename: payload.filename ?? undefined,
    };
  } else {
    outbound = { to: data.phone, type: "text", text: data.message.body ?? "" };
  }

  const { publishRealtime } = await import("./realtime.js");

  // Bolsa + fusible/topes de exposición financiera: solo plantillas (las que cuestan).
  if (outbound.type === "template") {
    const gate = await chargeTemplateSend(organizationId, data.message.id, templateCategory);
    if (gate.blocked) {
      await withTenant(organizationId, async (tx) => {
        await tx.message.update({ where: { id: data.message.id }, data: { status: "FAILED", error: gate.userMessage } });
        await tx.message.create({
          data: {
            organizationId,
            conversationId: data.message.conversationId,
            direction: "OUTBOUND",
            type: "SYSTEM",
            body: `⚠ Envío no realizado: ${gate.userMessage}`,
            authorType: "SYSTEM",
            status: "SENT",
            visibility: "PUBLIC",
          },
        });
        // Traza para el Super Admin (panel "últimos rechazados"): qué condición bloqueó.
        await tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "messaging",
            type: "template.blocked",
            status: "warning",
            message: gate.userMessage,
            payload: { reason: gate.reason, conversationId: data.message.conversationId, messageId: data.message.id },
          },
        });
      });
      await publishRealtime(organizationId, { type: "message.updated", conversationId: data.message.conversationId });
      return; // no se envía ni se reintenta
    }
  }

  try {
    const sent = await getChannelProvider().send(auth.phoneNumberId, outbound, { accessToken: auth.accessToken });
    await withTenant(organizationId, (tx) =>
      tx.message.update({
        where: { id: data.message.id },
        data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() },
      }),
    );
    await publishRealtime(organizationId, { type: "message.updated", conversationId: data.message.conversationId });
  } catch (err) {
    // En errores de config del canal, guarda el mensaje CLARO (no el 400 crudo).
    const failText = err instanceof ChannelConfigError ? err.userMessage : (err as Error).message.slice(0, 500);
    await withTenant(organizationId, (tx) =>
      tx.message.update({ where: { id: data.message.id }, data: { status: "FAILED", error: failText } }),
    );
    // Diagnóstico del #133010: si el número tiene credencial propia pero NO
    // pudimos usar el token del canal (usamos el global), deja constancia clara del
    // motivo en Salud — el caso típico es CREDENTIALS_ENCRYPTION_KEY del worker ≠ API.
    if (auth.tokenSource && auth.tokenSource !== "channel") {
      const reason =
        auth.tokenSource === "global-decrypt-failed"
          ? "El worker NO pudo descifrar el token del canal (revisa que CREDENTIALS_ENCRYPTION_KEY del worker sea IDÉNTICA a la del API) y usó el token global — por eso Meta rechaza el número."
          : auth.tokenSource === "global-no-credential"
            ? "El canal no tiene un token propio cargado; se usó el token global. Carga el token en Canales → Editar."
            : "El envío usó el token global de la plataforma (el número no resolvió a un canal con token propio).";
      await withTenant(organizationId, (tx) =>
        tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "whatsapp",
            type: "channel.token_fallback",
            status: "warning",
            message: reason,
            payload: { tokenSource: auth.tokenSource, phoneNumberId: auth.phoneNumberId, channelConnectionId: auth.channelConnectionId },
          },
        }),
      ).catch(() => undefined);
    }
    await publishRealtime(organizationId, { type: "message.updated", conversationId: data.message.conversationId });
    // Auth (token) o configuración (nombre para mostrar, registro, pago…): marcar
    // el canal con un aviso y NO reintentar en bucle — no se arreglan solos.
    if (err instanceof ChannelAuthError) {
      await markChannelAuthError(organizationId, auth.channelConnectionId, err.message);
      return;
    }
    if (err instanceof ChannelConfigError) {
      await markChannelConfigError(organizationId, auth.channelConnectionId, err.userMessage);
      return;
    }
    throw err; // BullMQ reintenta según la política del worker
  }
}
