import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import {
  applyQuietHours,
  getEvent,
  isCritical,
  render,
  resolveEnabledChannels,
  type NotifChannel,
  type NotifEventDef,
  type NotificationChannel,
  type NotifJob,
  type NotifRecipientContext,
  type UserNotifPrefs,
} from "@conversia/notifications";
import { emailChannel, inAppChannel } from "./channels";
import { scheduleWhatsappEscalation } from "./whatsapp-escalation";

/**
 * Registro de canales. Bloque 2: in_app + email. web_push, native_push y whatsapp
 * se registran en el bloque siguiente; mientras no existan, el despachador anota
 * la entrega como "skipped" y sigue con los demás (un canal no bloquea a otro).
 */
const CHANNELS: Partial<Record<NotifChannel, NotificationChannel>> = {
  in_app: inAppChannel,
  email: emailChannel,
};

/** Registra/actualiza canales en caliente (lo usa el bloque de Web Push/WhatsApp). */
export function registerChannel(ch: NotificationChannel): void {
  CHANNELS[ch.channel] = ch;
}

let redis: IORedis | undefined;
function getRedis(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

/** Deduplicación: ¿el usuario está mirando esa conversación en el panel ahora? */
async function isViewing(userId: string, conversationId?: string): Promise<boolean> {
  if (!conversationId) return false;
  try {
    return (await getRedis().get(`notif:viewing:${userId}`)) === conversationId;
  } catch {
    return false;
  }
}

const INTRUSIVE: NotifChannel[] = ["web_push", "native_push"];

/**
 * Procesa un job de notificación: para cada destinatario resuelve preferencias,
 * horario silencioso, dedup y despacha por cada canal habilitado, registrando la
 * entrega. Un fallo de canal nunca frena a los demás.
 */
export async function processNotificationJob(job: NotifJob): Promise<void> {
  const event = getEvent(job.eventKey);
  if (!event) return;
  const prisma = getAdminPrisma();

  const org = await prisma.organization.findUnique({
    where: { id: job.organizationId },
    select: { timezone: true, settings: true },
  });
  const tz = org?.timezone ?? "America/Santiago";
  const allPrefs = (((org?.settings ?? {}) as Record<string, any>).notifPrefs ?? {}) as Record<string, UserNotifPrefs>;

  const userIds = job.userIds?.length ? job.userIds : await resolveRecipients(prisma, job.organizationId, event, job.context ?? {});
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: { id: true, email: true, name: true },
  });
  const now = new Date();

  for (const user of users) {
    const prefs = allPrefs[user.id] ?? {};
    let channels = applyQuietHours(resolveEnabledChannels(event, prefs), event, prefs, now, tz);

    // Dedup: si ya está mirando esa conversación, nada de push (in_app/email sí).
    const viewing = await isViewing(user.id, job.conversationId);
    if (viewing) channels = channels.filter((c) => !INTRUSIVE.includes(c) && c !== "whatsapp");

    // WhatsApp NO es canal inmediato: es una ESCALERA. Si el evento es crítico y
    // el usuario la activó, se agenda con retraso; se cancela sola si atiende.
    channels = channels.filter((c) => c !== "whatsapp");
    if (isCritical(event.key) && event.channels.includes("whatsapp") && prefs.whatsapp?.enabled === true && job.conversationId && !viewing) {
      await scheduleWhatsappEscalation(
        {
          organizationId: job.organizationId,
          userId: user.id,
          eventKey: event.key,
          conversationId: job.conversationId,
          throttlePerHour: prefs.whatsapp.throttlePerHour ?? 4,
          contactName: String(job.data.contactName ?? "un cliente"),
        },
        prefs.whatsapp.delayMinutes ?? 5,
      ).catch(() => undefined);
    }

    // Incluye conversationId (va en job.conversationId, no en job.data) para que el
    // deep link "/inbox?c={conversationId}" se rellene y la notificación abra el mensaje
    // correcto — sin esto el link salía "/inbox?c=" y caía en una pantalla vacía.
    const renderData = { ...job.data, conversationId: job.conversationId };
    const title = render(event.title, renderData);
    const body = render(event.body, renderData);
    const link = event.link ? render(event.link, renderData) : undefined;

    for (const channel of channels) {
      const impl = CHANNELS[channel];
      const base = { organizationId: job.organizationId, userId: user.id, eventKey: event.key, channel };
      if (!impl) {
        await recordDelivery(prisma, { ...base, status: "skipped", error: "canal no disponible" });
        continue;
      }
      try {
        const result = await impl.send({
          userId: user.id,
          organizationId: job.organizationId,
          event,
          title,
          body,
          link,
          data: { ...job.data, conversationId: job.conversationId, userEmail: user.email, userName: user.name },
        });
        await recordDelivery(prisma, { ...base, status: result.status, error: result.error });
        if (result.expiredIdentifiers?.length) await cleanupExpired(prisma, user.id, result.expiredIdentifiers);
      } catch (e) {
        await recordDelivery(prisma, { ...base, status: "failed", error: (e as Error).message.slice(0, 300) });
      }
    }
  }
}

/**
 * Resuelve la audiencia del evento a ids de usuario, según el contexto. Excluye
 * al actor (no te notificas a ti mismo). Cross-tenant vía admin prisma.
 */
async function resolveRecipients(
  prisma: ReturnType<typeof getAdminPrisma>,
  organizationId: string,
  event: NotifEventDef,
  ctx: NotifRecipientContext,
): Promise<string[]> {
  const ids = new Set<string>();
  const needsAdmins = event.audience.includes("tenant_admins");
  const needsOwner = event.audience.includes("owner");

  if (event.audience.includes("assigned_user") && ctx.assignedUserId) ids.add(ctx.assignedUserId);

  if (event.audience.includes("team") && ctx.teamId) {
    const members = await prisma.teamMember.findMany({ where: { teamId: ctx.teamId, organizationId }, select: { userId: true } });
    members.forEach((m) => ids.add(m.userId));
  }

  if (needsAdmins || needsOwner) {
    const members = await prisma.organizationUser.findMany({
      where: { organizationId, active: true },
      select: { userId: true, roleId: true },
    });
    const roles = await prisma.role.findMany({
      where: { organizationId, code: { in: ["owner", "admin"] } },
      select: { id: true, code: true },
    });
    const codeById = new Map(roles.map((r) => [r.id, r.code]));
    for (const m of members) {
      const code = codeById.get(m.roleId);
      if (needsOwner && code === "owner") ids.add(m.userId);
      if (needsAdmins && (code === "owner" || code === "admin")) ids.add(m.userId);
    }
  }

  if (ctx.actorUserId) ids.delete(ctx.actorUserId);
  return [...ids];
}

async function recordDelivery(
  prisma: ReturnType<typeof getAdminPrisma>,
  d: { organizationId: string; userId: string; eventKey: string; channel: string; status: string; error?: string; deviceId?: string },
): Promise<void> {
  await prisma.notificationDelivery
    .create({ data: { ...d, error: d.error ?? null } })
    .catch(() => undefined);
}

/** Desactiva dispositivos que el proveedor reportó como caducados. */
async function cleanupExpired(prisma: ReturnType<typeof getAdminPrisma>, userId: string, identifiers: string[]): Promise<void> {
  await prisma.pushDevice
    .updateMany({ where: { userId, identifier: { in: identifiers } }, data: { active: false } })
    .catch(() => undefined);
}
