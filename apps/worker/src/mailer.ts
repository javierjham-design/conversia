import nodemailer from "nodemailer";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma, withTenant } from "@conversia/database";
import { QUEUE_NAMES, type EmailJob } from "@conversia/types";
import { decryptCredential } from "./credentials";

/**
 * Correo del tenant — dos modos:
 *  - platform: remitente de la plataforma vía Resend (RESEND_API_KEY/RESEND_FROM)
 *  - smtp: servidor propio del tenant (integration_connections provider=email,
 *    contraseña cifrada en integration_credentials)
 * SOLO correo interno al equipo (escalamientos, resúmenes, alertas, paso de
 * workflow) — jamás correo masivo a pacientes.
 */

let connection: IORedis | undefined;
let emailQueue: Queue<EmailJob> | undefined;

export function getEmailQueue(): Queue<EmailJob> {
  if (!emailQueue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    emailQueue = new Queue(QUEUE_NAMES.emails, { connection });
  }
  return emailQueue;
}

export interface EmailIntegration {
  mode: "platform" | "smtp";
  from: string | null;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string } | null;
  escalation: { enabled: boolean; minutes: number; recipients: string[] };
  dailySummary: { enabled: boolean; hour: number; recipients: string[] };
  alerts: { enabled: boolean; recipients: string[] };
  connectionId: string;
}

/** Lee la conexión de correo del tenant (null si no está conectada/activa). */
export async function getEmailIntegration(organizationId: string): Promise<EmailIntegration | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider: "email", status: { not: "inactive" } } });
    if (!conn) return null;
    const cfg = (conn.config as Record<string, any>) ?? {};
    let pass = "";
    if (conn.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
      if (cred) {
        try {
          pass = decryptCredential(cred.ciphertext);
        } catch {
          /* ilegible → smtp fallará y quedará registrado */
        }
      }
    }
    return {
      mode: cfg.mode === "smtp" ? "smtp" : "platform",
      from: cfg.from ?? null,
      smtp:
        cfg.mode === "smtp" && cfg.smtp?.host
          ? { host: String(cfg.smtp.host), port: Number(cfg.smtp.port ?? 587), secure: Boolean(cfg.smtp.secure), user: String(cfg.smtp.user ?? ""), pass }
          : null,
      escalation: { enabled: Boolean(cfg.escalation?.enabled), minutes: Number(cfg.escalation?.minutes ?? 10), recipients: cfg.escalation?.recipients ?? [] },
      dailySummary: { enabled: Boolean(cfg.dailySummary?.enabled), hour: Number(cfg.dailySummary?.hour ?? 8), recipients: cfg.dailySummary?.recipients ?? [] },
      alerts: { enabled: Boolean(cfg.alerts?.enabled), recipients: cfg.alerts?.recipients ?? [] },
      connectionId: conn.id,
    };
  });
}

/** Envía el correo según el modo del tenant (platform si no hay conexión). */
export async function sendTenantEmail(
  organizationId: string,
  mail: { to: string[]; subject: string; html: string },
): Promise<{ ok: boolean; detail: string }> {
  const env = getEnv();
  const integration = await getEmailIntegration(organizationId);
  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "email", type: status === "ok" ? "email.sent" : "email.error", status, message },
      }),
    ).catch(() => undefined);

  try {
    if (integration?.mode === "smtp" && integration.smtp) {
      const transport = nodemailer.createTransport({
        host: integration.smtp.host,
        port: integration.smtp.port,
        secure: integration.smtp.secure,
        auth: integration.smtp.user ? { user: integration.smtp.user, pass: integration.smtp.pass } : undefined,
        connectionTimeout: 10_000,
      });
      await transport.sendMail({
        from: integration.from ?? integration.smtp.user,
        to: mail.to.join(", "),
        subject: mail.subject,
        html: mail.html,
      });
      await log("ok", `Correo «${mail.subject}» → ${mail.to.join(", ")} (SMTP propio)`);
      return { ok: true, detail: "Enviado por SMTP del tenant" };
    }
    // Modo plataforma (Resend)
    if (!env.RESEND_API_KEY) {
      await log("error", "Correo no enviado: la plataforma no tiene RESEND_API_KEY configurada");
      return { ok: false, detail: "Remitente de plataforma no configurado" };
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.RESEND_FROM, to: mail.to, subject: mail.subject, html: mail.html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await log("error", `Resend rechazó el correo: ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, detail: `Resend ${res.status}` };
    }
    await log("ok", `Correo «${mail.subject}» → ${mail.to.join(", ")} (plataforma)`);
    return { ok: true, detail: "Enviado por la plataforma" };
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    await log("error", `Error enviando correo: ${message}`);
    if (integration) {
      await withTenant(organizationId, (tx) =>
        tx.integrationConnection.update({ where: { id: integration.connectionId }, data: { lastError: message } }),
      ).catch(() => undefined);
    }
    return { ok: false, detail: message };
  }
}

/** Procesa un job de la cola de correos (reintentos vía BullMQ). */
export async function processEmailJob(job: EmailJob): Promise<void> {
  // Escalamiento: si alguien ya tomó la conversación, no molestar.
  if (job.kind === "escalation" && job.handoffId) {
    const handoff = await withTenant(job.organizationId, (tx) =>
      tx.humanHandoff.findUnique({ where: { id: job.handoffId! } }),
    );
    if (!handoff || handoff.status !== "PENDING") return;
  }
  const result = await sendTenantEmail(job.organizationId, { to: job.to, subject: job.subject, html: job.html });
  if (!result.ok) throw new Error(result.detail); // BullMQ reintenta con backoff
}

/** Escalamiento: agenda el aviso si el handoff sigue pendiente en X minutos. */
export async function enqueueEscalationEmail(organizationId: string, handoffId: string, conversationId: string): Promise<void> {
  try {
    const integration = await getEmailIntegration(organizationId);
    if (!integration?.escalation.enabled || integration.escalation.recipients.length === 0) return;
    const escalationTo = await filterRecipientsByPref(organizationId, integration.escalation.recipients, "aiEscalation");
    if (!escalationTo.length) return;
    const env = getEnv();
    const url = `${env.WEB_URL ?? ""}/inbox`;
    await getEmailQueue().add(
      "escalation",
      {
        organizationId,
        kind: "escalation",
        handoffId,
        to: escalationTo,
        subject: "⚠ Conversación escalada sin atender — TuBot",
        html: `<p>Una conversación fue escalada a humano hace ${integration.escalation.minutes} minutos y sigue sin respuesta.</p><p><a href="${url}">Abrir la bandeja</a> (conversación ${conversationId.slice(0, 8)}…)</p>`,
      },
      { delay: integration.escalation.minutes * 60_000, attempts: 4, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
  } catch (err) {
    console.error("✖ enqueueEscalationEmail:", (err as Error).message);
  }
}

/** Alerta de integración en error (p. ej. token de WhatsApp vencido). */

/**
 * Preferencias personales (/settings/notifications): si un destinatario es un
 * usuario del panel con la preferencia apagada, se excluye. Correos externos
 * (sin cuenta) pasan siempre. Defaults: todo ON menos dailySummary.
 */
export async function filterRecipientsByPref(
  organizationId: string,
  recipients: string[],
  pref: "aiEscalation" | "dailySummary" | "dataJobs",
): Promise<string[]> {
  if (!recipients.length) return recipients;
  const prisma = getAdminPrisma();
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const allPrefs = (((org?.settings ?? {}) as Record<string, any>).notifPrefs ?? {}) as Record<string, any>;
  const members = await prisma.organizationUser.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, email: true } } },
  });
  const byEmail = new Map(members.map((mb) => [mb.user.email.toLowerCase(), mb.user.id]));
  const defaults: Record<string, boolean> = { aiEscalation: true, dailySummary: false, dataJobs: true };
  return recipients.filter((email) => {
    const userId = byEmail.get(email.toLowerCase());
    if (!userId) return true; // correo externo: siempre
    const p = allPrefs[userId] ?? {};
    return (p[pref] ?? defaults[pref]) !== false && (pref !== "dailySummary" || (p[pref] ?? defaults[pref]) === true);
  });
}

export async function enqueueIntegrationAlert(organizationId: string, subject: string, html: string): Promise<void> {
  try {
    const integration = await getEmailIntegration(organizationId);
    if (!integration?.alerts.enabled || integration.alerts.recipients.length === 0) return;
    await getEmailQueue().add(
      "alert",
      { organizationId, kind: "alert", to: integration.alerts.recipients, subject, html },
      { attempts: 4, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
  } catch (err) {
    console.error("✖ enqueueIntegrationAlert:", (err as Error).message);
  }
}

/**
 * Resumen diario por tenant a la hora configurada (zona horaria de la org).
 * Tick horario; idempotente por fecha (config.dailySummary.lastSentDate).
 */
export function startDailyDigests(): () => void {
  const prisma = getAdminPrisma();
  const run = async () => {
    const conns = await prisma.integrationConnection.findMany({ where: { provider: "email", status: { not: "inactive" } } });
    for (const conn of conns) {
      try {
        const cfg = (conn.config as Record<string, any>) ?? {};
        const ds = cfg.dailySummary ?? {};
        if (!ds.enabled || !Array.isArray(ds.recipients) || ds.recipients.length === 0) continue;
        const dsRecipients = await filterRecipientsByPref(conn.organizationId, ds.recipients as string[], "dailySummary");
        if (!dsRecipients.length) continue;
        const org = await prisma.organization.findUnique({ where: { id: conn.organizationId }, select: { name: true, timezone: true } });
        const tz = org?.timezone ?? "America/Santiago";
        const now = new Date();
        const hourInTz = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now));
        const dateInTz = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // YYYY-MM-DD
        if (hourInTz !== Number(ds.hour ?? 8) || ds.lastSentDate === dateInTz) continue;

        const since = new Date(Date.now() - 24 * 3600 * 1000);
        const [conversations, contacts, leads, appointments] = await withTenant(conn.organizationId, (tx) =>
          Promise.all([
            tx.conversation.count({ where: { lastMessageAt: { gte: since } } }),
            tx.contact.count({ where: { createdAt: { gte: since } } }),
            tx.lead.count({ where: { createdAt: { gte: since } } }),
            tx.appointment.count({ where: { createdAt: { gte: since } } }),
          ]),
        );
        await getEmailQueue().add(
          "daily",
          {
            organizationId: conn.organizationId,
            kind: "daily_summary",
            to: dsRecipients,
            subject: `Resumen diario — ${org?.name ?? "TuBot"}`,
            html: `<h3>Últimas 24 horas</h3><ul><li><b>${conversations}</b> conversaciones activas</li><li><b>${contacts}</b> contactos nuevos</li><li><b>${leads}</b> leads nuevos</li><li><b>${appointments}</b> citas creadas</li></ul>`,
          },
          { attempts: 4, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 100, removeOnFail: 500 },
        );
        await prisma.integrationConnection.update({
          where: { id: conn.id },
          data: { config: { ...cfg, dailySummary: { ...ds, lastSentDate: dateInTz } } as object },
        });
      } catch (err) {
        console.error(`✖ daily digest org ${conn.organizationId}:`, (err as Error).message);
      }
    }
  };
  const interval = setInterval(() => void run(), 15 * 60 * 1000); // cada 15 min (hora exacta ±15)
  const boot = setTimeout(() => void run(), 90 * 1000);
  console.log("✔ Resumen diario por correo activo (tick cada 15 min)");
  return () => {
    clearInterval(interval);
    clearTimeout(boot);
  };
}
