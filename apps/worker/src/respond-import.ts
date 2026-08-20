import type { Job } from "bullmq";
import { withTenant } from "@conversia/database";
import type { MessageImportJob, MessageImportResult, MessageImportRow } from "@conversia/types";

// Import de HISTORIAL de mensajes de Respond.io. Regla de oro (igual que las
// etiquetas del import de contactos, que NO disparan tag_added): esto ESCRIBE
// en la base y NADA más — sin turnos de agente, sin dispatchEvent/flujos, sin
// webhooks salientes, sin recordUsage/wallet, sin envíos por el canal. Son
// mensajes de marzo: nadie tiene que "responderlos". NO lo "arregles" luego.
// Lecciones del import de contactos aplicadas: lotes chicos con timeout
// explícito y un lote fallido NO se lleva el job entero.

const CHUNK = 500;
const BATCH_TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

/** Offset (ms) de una zona horaria en un instante dado — sin depender del TZ del server. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - at.getTime();
}

/** "YYYY-MM-DD HH:mm:ss" en America/Santiago → Date UTC (respeta DST chileno). */
export function santiagoToUtc(s: string): Date {
  const [d, t] = s.trim().split(/[ T]/);
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi, se] = (t ?? "00:00:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, day, h, mi, se ?? 0);
  const offset = tzOffsetMs(new Date(guess), "America/Santiago");
  return new Date(guess - offset);
}

export interface MappedMessage {
  externalId: string;
  direction: "INBOUND" | "OUTBOUND";
  authorType: "CONTACT" | "USER" | "AGENT";
  type: "TEXT" | "STICKER" | "AUDIO" | "IMAGE" | "DOCUMENT" | "VIDEO" | "SYSTEM";
  body: string | null;
  payload: Record<string, unknown>;
  sentAt: Date;
  respondContactId: string;
  channelId: string;
}

/** Mapeo PURO fila de Respond → nuestro modelo de Message. */
export function mapRespondRow(row: MessageImportRow): MappedMessage | null {
  if (!row.messageId || !row.contactId) return null;
  let content: any = {};
  try {
    content = JSON.parse(row.content || "{}");
  } catch {
    content = { raw: row.content };
  }
  const direction = row.messageType === "incoming" ? "INBOUND" : "OUTBOUND";
  const authorType = row.senderType === "contact" ? "CONTACT" : row.senderType === "user" ? "USER" : "AGENT";
  let type: MappedMessage["type"] = "SYSTEM";
  if (row.contentType === "text" || row.contentType === "quick_reply") type = "TEXT";
  else if (row.contentType === "sticker") type = "STICKER";
  else if (row.contentType === "attachment") {
    const at = String(content?.attachment?.type ?? content?.type ?? "").toLowerCase();
    type = at.includes("audio") ? "AUDIO" : at.includes("image") ? "IMAGE" : at.includes("video") ? "VIDEO" : "DOCUMENT";
  }
  const body =
    typeof content?.text === "string" && content.text.length
      ? content.text
      : row.contentType === "text"
        ? String(content?.text ?? "")
        : `[${row.contentType}]`;
  return {
    externalId: row.messageId,
    direction,
    authorType,
    type,
    body,
    // payload completo: JSON original + senderType (no perder el valor crudo)
    payload: { respond: content, respondSenderType: row.senderType, respondChannelId: row.channelId },
    sentAt: santiagoToUtc(row.dateTime),
    respondContactId: row.contactId,
    channelId: row.channelId,
  };
}

export async function processMessageImport(job: Job<MessageImportJob>): Promise<MessageImportResult> {
  const { organizationId: orgId, userId, rows } = job.data;
  const result: MessageImportResult = { imported: 0, skippedDuplicate: 0, skippedNoContact: 0, conversationsCreated: 0, errors: [] };

  // Refs UNA vez por job: id_respond_io → contactId
  const respondToContact = await withTenant(orgId, async (tx) => {
    const def = await tx.customFieldDefinition.findFirst({ where: { entity: "contact", key: "id_respond_io" } });
    if (!def) return new Map<string, string>();
    const values = await tx.customFieldValue.findMany({ where: { definitionId: def.id }, select: { entityId: true, value: true } });
    return new Map(values.map((v) => [String(v.value).replace(/^"|"$/g, ""), v.entityId]));
  });

  // Conversación por (contacto, canal Respond) — caché del job + resumen final
  const convCache = new Map<string, string>();
  const convSummary = new Map<string, { lastAt: Date; preview: string }>();

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      await withTenant(
        orgId,
        async (tx) => {
          for (const raw of chunk) {
            const m = mapRespondRow(raw);
            if (!m) continue;
            const contactId = respondToContact.get(m.respondContactId);
            if (!contactId) {
              result.skippedNoContact++;
              continue;
            }
            const convKey = `${contactId}:${m.channelId}`;
            let conversationId = convCache.get(convKey);
            if (!conversationId) {
              const existing = await tx.conversation.findFirst({
                where: { contactId, meta: { path: ["respondChannelId"], equals: m.channelId } },
                select: { id: true },
              });
              if (existing) conversationId = existing.id;
              else {
                const conv = await tx.conversation.create({
                  data: {
                    organizationId: orgId,
                    contactId,
                    status: "CLOSED", // historia: nada abierto
                    aiEnabled: false, // que ningún agente "responda" mensajes de marzo
                    meta: { importedFrom: "respond.io", respondChannelId: m.channelId } as object,
                  },
                  select: { id: true },
                });
                conversationId = conv.id;
                result.conversationsCreated++;
              }
              convCache.set(convKey, conversationId);
            }
            const created = await tx.message.createMany({
              data: [
                {
                  organizationId: orgId,
                  conversationId,
                  direction: m.direction,
                  type: m.type,
                  body: m.body,
                  payload: m.payload as object,
                  externalId: m.externalId,
                  status: m.direction === "OUTBOUND" ? "SENT" : "DELIVERED", // históricos: ya salieron
                  authorType: m.authorType,
                  sentAt: m.sentAt,
                  createdAt: m.sentAt,
                },
              ],
              skipDuplicates: true, // idempotencia por (organizationId, externalId)
            });
            if (created.count === 0) result.skippedDuplicate++;
            else {
              result.imported++;
              const s = convSummary.get(conversationId);
              if (!s || m.sentAt > s.lastAt) convSummary.set(conversationId, { lastAt: m.sentAt, preview: (m.body ?? "").slice(0, 120) });
            }
          }
        },
        undefined,
        BATCH_TX_OPTS,
      );
    } catch (err) {
      result.errors.push({ row: i + 1, reason: `lote filas ${i + 1}-${Math.min(i + CHUNK, rows.length)} falló: ${(err as Error).message.slice(0, 200)}` });
    }
    await job.updateProgress({ processed: Math.min(i + CHUNK, rows.length), total: rows.length });
  }

  // lastMessageAt / preview por conversación (solo si el import trajo algo nuevo)
  await withTenant(orgId, async (tx) => {
    for (const [conversationId, s] of convSummary) {
      const current = await tx.conversation.findUnique({ where: { id: conversationId }, select: { lastMessageAt: true } });
      if (!current?.lastMessageAt || s.lastAt > current.lastMessageAt) {
        await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: s.lastAt, lastMessagePreview: s.preview } });
      }
    }
    await tx.auditLog.create({
      data: { organizationId: orgId, actorType: "user", actorId: userId, action: "message.import", entityType: "message", after: { ...result, errors: result.errors.length } as object },
    });
  }, undefined, BATCH_TX_OPTS);

  result.errors = result.errors.slice(0, 100);
  return result;
}
