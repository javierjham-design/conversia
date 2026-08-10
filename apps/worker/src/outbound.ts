import { withTenant } from "@conversia/database";
import type { OutboundJob } from "@conversia/types";
import { ChannelAuthError, markChannelAuthError, resolveChannelAuth } from "./channel-auth";
import { getChannelProvider } from "./channel-providers";
import { renderTemplateBody, resolveTemplateParams } from "./template-params";
import { guardTemplateSend } from "./messaging-guard";

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
    if (!conversation?.contact.phone) return null;
    return { message, phone: conversation.contact.phone, channelConnectionId: conversation.channelConnectionId };
  });

  if (!data) return;
  const auth = await resolveChannelAuth(organizationId, { channelConnectionId: data.channelConnectionId });

  // Plantilla HSM (fuera de la ventana de 24 h): parámetros resueltos con los
  // datos reales del contacto según el mapeo posición→campo de la plantilla.
  let outbound: import("@conversia/types").OutboundMessage;
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

  // Fusible/topes de exposición financiera: solo plantillas (las que cuestan).
  if (outbound.type === "template") {
    const gate = await guardTemplateSend(organizationId);
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
    await withTenant(organizationId, (tx) =>
      tx.message.update({
        where: { id: data.message.id },
        data: { status: "FAILED", error: (err as Error).message.slice(0, 500) },
      }),
    );
    await publishRealtime(organizationId, { type: "message.updated", conversationId: data.message.conversationId });
    // Error de auth: marcar el canal (banner Reautorizar) y NO reintentar en
    // bucle — el token no se arregla solo. Otros errores sí reintentan.
    if (err instanceof ChannelAuthError) {
      await markChannelAuthError(organizationId, auth.channelConnectionId, err.message);
      return;
    }
    throw err; // BullMQ reintenta según la política del worker
  }
}
