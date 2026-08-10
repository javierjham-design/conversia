import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { QUEUE_NAMES } from "@conversia/types";
import { resolveChannelAuth } from "../channel-auth";
import { getChannelProvider } from "../channel-providers";

/**
 * ESCALERA DE WHATSAPP: no es un canal paralelo. Cuando un evento CRÍTICO se
 * dispara y el usuario tiene la escalera activada, se agenda un aviso por WhatsApp
 * con RETRASO (default 5 min). Si antes de eso alguien ATIENDE la conversación
 * (la abre o toma control → flag `wa:attended:{conversationId}` que pone la API),
 * el aviso se cancela solo. Throttle por hora. Usa la plantilla HSM del tenant.
 */

export interface WaEscalationJob {
  organizationId: string;
  userId: string;
  eventKey: string;
  conversationId: string;
  throttlePerHour: number;
  contactName: string;
}

let connection: IORedis | undefined;
let queue: Queue<WaEscalationJob> | undefined;

function conn(): IORedis {
  if (!connection) connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export function getWaEscalationQueue(): Queue<WaEscalationJob> {
  if (!queue) queue = new Queue(QUEUE_NAMES.whatsappEscalation, { connection: conn() });
  return queue;
}

/** Agenda el aviso por WhatsApp con retraso. jobId determinista por conversación+usuario. */
export async function scheduleWhatsappEscalation(job: WaEscalationJob, delayMinutes: number): Promise<void> {
  await getWaEscalationQueue().add("wa-escalation", job, {
    delay: Math.max(1, delayMinutes) * 60_000,
    jobId: `wa:${job.conversationId}:${job.userId}`,
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}

/** Dispara el aviso si sigue sin atenderse; respeta throttle y plantilla del tenant. */
export async function processWhatsappEscalation(job: WaEscalationJob): Promise<void> {
  const prisma = getAdminPrisma();
  const record = (status: string, error?: string) =>
    prisma.notificationDelivery
      .create({ data: { organizationId: job.organizationId, userId: job.userId, eventKey: job.eventKey, channel: "whatsapp", status, error: error ?? null } })
      .catch(() => undefined);

  // ¿La conversación ya fue atendida (abierta / tomada)? → no molestar.
  if ((await conn().get(`wa:attended:${job.conversationId}`)) === "1") {
    await record("skipped", "conversación atendida a tiempo");
    return;
  }

  // Throttle por hora y usuario.
  const bucket = `wa:throttle:${job.userId}:${Math.floor(Date.now() / 3_600_000)}`;
  const count = await conn().incr(bucket);
  if (count === 1) await conn().expire(bucket, 3600);
  if (count > Math.max(1, job.throttlePerHour)) {
    await record("skipped", "throttle por hora alcanzado");
    return;
  }

  const [user, org] = await Promise.all([
    prisma.user.findUnique({ where: { id: job.userId }, select: { phone: true, name: true } }),
    prisma.organization.findUnique({ where: { id: job.organizationId }, select: { settings: true } }),
  ]);
  if (!user?.phone) {
    await record("skipped", "usuario sin teléfono");
    return;
  }
  const tpl = (((org?.settings ?? {}) as any).notifications?.whatsappEscalationTemplate ?? {}) as { name?: string; language?: string };
  if (!tpl.name) {
    await record("skipped", "sin plantilla HSM configurada");
    return;
  }

  try {
    const auth = await resolveChannelAuth(job.organizationId, {});
    if (!auth.phoneNumberId) {
      await record("skipped", "sin canal de WhatsApp");
      return;
    }
    const sent = await getChannelProvider().send(
      auth.phoneNumberId,
      { to: user.phone, type: "template", templateName: tpl.name, templateLanguage: tpl.language ?? "es", templateParams: [job.contactName] },
      { accessToken: auth.accessToken },
    );
    await record("sent", sent.externalId ? `id ${sent.externalId}` : undefined);
  } catch (e) {
    await record("failed", (e as Error).message.slice(0, 200));
    throw e; // BullMQ reintenta
  }
}
