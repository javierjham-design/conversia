import { getPrisma, withTenant } from "@conversia/database";
import type { InboundJob } from "@conversia/types";
import { runAgentTurn } from "./agent-turn";
import { cancelTimersOnReply, dispatchEvent } from "./workflow-runtime";

interface ParsedInbound {
  phoneNumberId: string;
  externalId: string;
  from: string;
  profileName?: string;
  type: string;
  text?: string;
  payload: unknown;
}

interface ParsedStatus {
  phoneNumberId: string;
  externalId: string;
  status: string;
}

/** Normaliza el payload del webhook de Meta (o del simulador, mismo formato). */
function parseWebhook(raw: any): { messages: ParsedInbound[]; statuses: ParsedStatus[] } {
  const messages: ParsedInbound[] = [];
  const statuses: ParsedStatus[] = [];
  for (const entry of raw?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const profileName = value?.contacts?.[0]?.profile?.name;
      for (const m of value?.messages ?? []) {
        messages.push({
          phoneNumberId,
          externalId: m.id,
          from: m.from,
          profileName,
          type: m.type ?? "unknown",
          text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title,
          payload: m,
        });
      }
      for (const s of value?.statuses ?? []) {
        statuses.push({ phoneNumberId, externalId: s.id, status: s.status });
      }
    }
  }
  return { messages, statuses };
}

/**
 * Resuelve el tenant a partir del número receptor. Lookup global (conexión
 * del worker) — ÚNICO punto donde se cruza el límite de tenant, y solo para
 * enrutar. "mock:<slug>" permite simular sin credenciales.
 */
async function resolveTenant(
  phoneNumberId: string,
): Promise<{ organizationId: string; channelConnectionId: string | null; clinicId: string | null } | null> {
  const prisma = getPrisma();
  if (phoneNumberId.startsWith("mock:")) {
    const slug = phoneNumberId.slice(5);
    const org = await prisma.organization.findUnique({ where: { slug } });
    if (!org) return null;
    const channel = await prisma.channelConnection.findFirst({
      where: { organizationId: org.id, type: "MOCK" },
    });
    return { organizationId: org.id, channelConnectionId: channel?.id ?? null, clinicId: channel?.clinicId ?? null };
  }
  const number = await prisma.whatsappPhoneNumber.findUnique({ where: { phoneNumberId } });
  if (!number) return null;
  return {
    organizationId: number.organizationId,
    channelConnectionId: number.channelConnectionId,
    clinicId: number.clinicId,
  };
}

export async function processInbound(job: InboundJob): Promise<void> {
  const { messages, statuses } = parseWebhook(job.raw);

  for (const status of statuses) {
    const tenant = await resolveTenant(status.phoneNumberId);
    if (!tenant) continue;
    await withTenant(tenant.organizationId, (tx) =>
      tx.message.updateMany({
        where: { externalId: status.externalId },
        data: {
          status:
            status.status === "read"
              ? "READ"
              : status.status === "delivered"
                ? "DELIVERED"
                : status.status === "failed"
                  ? "FAILED"
                  : "SENT",
        },
      }),
    );
  }

  for (const msg of messages) {
    const tenant = await resolveTenant(msg.phoneNumberId);
    if (!tenant) {
      console.warn(`⚠ Mensaje para número desconocido ${msg.phoneNumberId} — descartado`);
      continue;
    }
    const { organizationId } = tenant;

    const result = await withTenant(organizationId, async (tx) => {
      // Idempotencia por wamid
      const dup = await tx.message.findUnique({
        where: { organizationId_externalId: { organizationId, externalId: msg.externalId } },
      });
      if (dup) return null;

      // Contacto por identidad de canal
      const channelType = msg.phoneNumberId.startsWith("mock:") ? "MOCK" : "WHATSAPP_CLOUD";
      let identity = await tx.contactIdentity.findUnique({
        where: {
          organizationId_channelType_externalId: {
            organizationId,
            channelType,
            externalId: msg.from,
          },
        },
        include: { contact: true },
      });
      let contact = identity?.contact ?? null;
      if (!contact) {
        contact = await tx.contact.create({
          data: {
            organizationId,
            clinicId: tenant.clinicId,
            firstName: msg.profileName ?? null,
            phone: msg.from,
            source: "whatsapp",
            firstContactAt: new Date(),
            lastContactAt: new Date(),
          },
        });
        await tx.contactIdentity.create({
          data: { organizationId, contactId: contact.id, channelType, externalId: msg.from },
        });
      } else {
        await tx.contact.update({ where: { id: contact.id }, data: { lastContactAt: new Date() } });
      }

      // Conversación abierta o nueva
      let conversation = await tx.conversation.findFirst({
        where: { contactId: contact.id, status: { in: ["OPEN", "PENDING"] } },
        orderBy: { createdAt: "desc" },
      });
      let started = false;
      if (!conversation) {
        const channel = tenant.channelConnectionId
          ? await tx.channelConnection.findUnique({ where: { id: tenant.channelConnectionId } })
          : null;
        conversation = await tx.conversation.create({
          data: {
            organizationId,
            clinicId: tenant.clinicId,
            contactId: contact.id,
            channelConnectionId: tenant.channelConnectionId,
            activeAgentId: channel?.defaultAgentId ?? null,
            status: "OPEN",
          },
        });
        started = true;
      }

      await tx.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          direction: "INBOUND",
          type: msg.type === "text" ? "TEXT" : "TEXT",
          body: msg.text ?? `[${msg.type}]`,
          payload: msg.payload as object,
          externalId: msg.externalId,
          status: "DELIVERED",
          authorType: "CONTACT",
          sentAt: new Date(),
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: (msg.text ?? `[${msg.type}]`).slice(0, 120),
          unreadCount: { increment: 1 },
        },
      });

      return { conversationId: conversation.id, contactId: contact.id, started };
    });

    if (!result) continue; // duplicado

    // El contacto respondió → cancelar seguimientos pendientes
    await cancelTimersOnReply(organizationId, result.conversationId);

    // Disparar workflows (conversación iniciada y mensaje recibido)
    const base = {
      organizationId,
      conversationId: result.conversationId,
      contactId: result.contactId,
      data: { text: msg.text ?? "" },
      occurredAt: new Date().toISOString(),
    };
    if (result.started) {
      await dispatchEvent({ ...base, type: "conversation_started" });
    }
    await dispatchEvent({ ...base, type: "message_received" });

    // Respuesta del agente activo (si la IA está habilitada)
    try {
      await runAgentTurn({ organizationId, conversationId: result.conversationId });
    } catch (err) {
      console.error(`✖ Error en turno de agente (${result.conversationId}):`, (err as Error).message);
    }
  }
}
