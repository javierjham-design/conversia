import type { Job } from "bullmq";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { QUEUE_NAMES, type BroadcastJob, type OutboundJob } from "@conversia/types";

// Difusión (envío masivo por plantilla). El asistente ya resolvió la audiencia y
// dejó los destinatarios en broadcast_recipients (PENDING). Aquí, por cada
// destinatario: se abre/reutiliza una conversación de WhatsApp, se crea un
// Message TEMPLATE PENDING y se ENCOLA en `outbound` — que es quien aplica la
// cadena de gating (plan + interruptor + bolsa + tope diario + fusible), envía a
// Meta y registra el estado. Así la difusión hereda reintentos y concurrencia del
// envío individual sin duplicar esa lógica, y respeta topes/saldo por mensaje.
//
// Reanudable: solo toma destinatarios PENDING; si el worker cae, al reintentar
// continúa por donde iba. Cancelable: relee el estado por lote y corta si pasó a
// CANCELED. Concurrencia 1 (ver main.ts) para no saturar la cola de salida.

const BATCH = 100;

let connection: IORedis | undefined;
let outboundQueue: Queue<OutboundJob> | undefined;
function getOutboundQueue(): Queue<OutboundJob> {
  if (!outboundQueue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    outboundQueue = new Queue(QUEUE_NAMES.outbound, { connection });
  }
  return outboundQueue;
}

export async function processBroadcast(job: Job<BroadcastJob>): Promise<void> {
  const { organizationId: orgId, broadcastId } = job.data;

  // 1) Cargar difusión + plantilla + canal. Marcar SENDING.
  const setup = await withTenant(orgId, async (tx) => {
    const b = await tx.broadcast.findUnique({ where: { id: broadcastId } });
    if (!b) return null;
    if (["CANCELED", "COMPLETED", "FAILED"].includes(b.status)) return null;
    const template = await tx.whatsappTemplate.findUnique({ where: { id: b.templateId } });
    if (!template || template.status !== "APPROVED") {
      await tx.broadcast.update({ where: { id: broadcastId }, data: { status: "FAILED" } });
      return null;
    }
    // Canal: el elegido, o el primer WhatsApp activo.
    const channel = b.channelConnectionId
      ? await tx.channelConnection.findFirst({ where: { id: b.channelConnectionId, type: "WHATSAPP_CLOUD" }, select: { id: true, defaultAgentId: true } })
      : await tx.channelConnection.findFirst({ where: { type: "WHATSAPP_CLOUD", status: "active" }, orderBy: { createdAt: "asc" }, select: { id: true, defaultAgentId: true } });
    if (!channel) {
      await tx.broadcast.update({ where: { id: broadcastId }, data: { status: "FAILED" } });
      return null;
    }
    await tx.broadcast.update({ where: { id: broadcastId }, data: { status: "SENDING", startedAt: b.startedAt ?? new Date() } });
    const components = ((template.body as Record<string, any>)?.components ?? []) as any[];
    const preview = components.find((c) => c?.type === "BODY")?.text ?? `[plantilla ${template.name}]`;
    return { channelId: channel.id, defaultAgentId: channel.defaultAgentId, templateId: template.id, templateName: template.name, preview };
  });
  if (!setup) return;

  // 2) Procesar destinatarios PENDING por lotes.
  for (;;) {
    // Corte por cancelación.
    const status = await withTenant(orgId, (tx) => tx.broadcast.findUnique({ where: { id: broadcastId }, select: { status: true } }));
    if (!status || status.status === "CANCELED") return;

    const pending = await withTenant(orgId, (tx) =>
      tx.broadcastRecipient.findMany({ where: { broadcastId, status: "PENDING" }, take: BATCH, select: { id: true, contactId: true } }),
    );
    if (pending.length === 0) break;

    for (const rec of pending) {
      try {
        const enqueued = await withTenant(orgId, async (tx) => {
          const contact = await tx.contact.findFirst({ where: { id: rec.contactId, deletedAt: null }, select: { id: true, phone: true, clinicId: true, blocked: true, doNotContact: true } });
          if (!contact?.phone || contact.blocked || contact.doNotContact) {
            await tx.broadcastRecipient.update({ where: { id: rec.id }, data: { status: "SKIPPED", error: "sin teléfono o no contactable" } });
            return null;
          }
          // Reutiliza conversación abierta en ESTE canal, o crea una.
          let conversation = await tx.conversation.findFirst({
            where: { contactId: contact.id, channelConnectionId: setup.channelId, status: { in: ["OPEN", "PENDING"] } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (!conversation) {
            conversation = await tx.conversation.create({
              data: {
                organizationId: orgId,
                clinicId: contact.clinicId ?? null,
                contactId: contact.id,
                channelConnectionId: setup.channelId,
                activeAgentId: setup.defaultAgentId ?? null,
                status: "OPEN",
              },
              select: { id: true },
            });
          }
          const msg = await tx.message.create({
            data: {
              organizationId: orgId,
              conversationId: conversation.id,
              direction: "OUTBOUND",
              type: "TEMPLATE",
              body: setup.preview,
              authorType: "SYSTEM",
              status: "PENDING",
              payload: { templateId: setup.templateId, templateName: setup.templateName, broadcastId },
            },
            select: { id: true },
          });
          await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date(), lastMessagePreview: setup.preview.slice(0, 120) } });
          await tx.broadcastRecipient.update({ where: { id: rec.id }, data: { status: "SENT", conversationId: conversation.id, messageId: msg.id } });
          return { conversationId: conversation.id, messageId: msg.id };
        });

        if (enqueued) {
          await getOutboundQueue().add("send", { organizationId: orgId, conversationId: enqueued.conversationId, messageId: enqueued.messageId }, { removeOnComplete: true, removeOnFail: 1000 });
          await withTenant(orgId, (tx) => tx.broadcast.update({ where: { id: broadcastId }, data: { sent: { increment: 1 } } }));
        }
      } catch (err) {
        await withTenant(orgId, async (tx) => {
          await tx.broadcastRecipient.update({ where: { id: rec.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 300) } });
          await tx.broadcast.update({ where: { id: broadcastId }, data: { failed: { increment: 1 } } });
        });
      }
    }
  }

  // 3) Cerrar.
  await withTenant(orgId, (tx) => tx.broadcast.update({ where: { id: broadcastId }, data: { status: "COMPLETED", completedAt: new Date() } }));
}
