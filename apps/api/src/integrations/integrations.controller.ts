import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ClarivaSchedulingProvider } from "@conversia/scheduling";
import { PLATFORM_PUBLIC_EVENTS } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { decryptSecret, encryptSecret, maskSecret } from "../common/crypto";
import { sendEmail as sendPlatformEmail } from "../common/email";
import { validateOutboundUrl } from "../common/url-guard";
import { getEnv } from "@conversia/config";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const clarivaSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(6),
});

const emailRecipients = z.array(z.string().email()).max(10).default([]);
const emailSchema = z.object({
  mode: z.enum(["platform", "smtp"]).default("platform"),
  from: z.string().trim().max(160).optional(),
  smtp: z
    .object({
      host: z.string().trim().min(3).max(200),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      user: z.string().trim().max(200).default(""),
      pass: z.string().max(500).optional(), // solo al crear/rotar; nunca se devuelve
    })
    .optional(),
  escalation: z.object({ enabled: z.boolean().default(false), minutes: z.coerce.number().int().min(2).max(240).default(10), recipients: emailRecipients }).default({ enabled: false, minutes: 10, recipients: [] }),
  dailySummary: z.object({ enabled: z.boolean().default(false), hour: z.coerce.number().int().min(0).max(23).default(8), recipients: emailRecipients }).default({ enabled: false, hour: 8, recipients: [] }),
  alerts: z.object({ enabled: z.boolean().default(true), recipients: emailRecipients }).default({ enabled: true, recipients: [] }),
});

const webhookSchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(200).nullable().optional(),
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  headers: z.record(z.string()).default({}),
  timeoutMs: z.coerce.number().int().min(1000).max(30000).default(10000),
  maxRetries: z.coerce.number().int().min(0).max(8).default(4),
  active: z.boolean().default(true),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

function assertUrlAllowed(url: string) {
  const check = validateOutboundUrl(url, { allowLocalhost: getEnv().NODE_ENV !== "production" });
  if (!check.ok) throw new BadRequestException(`URL rechazada: ${check.reason}`);
}

@Controller("integrations")
export class IntegrationsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  /** Estado global de integraciones + métricas reales del tenant. */
  @Get()
  overview() {
    const ctx = requireContext();
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [scheduling, webhooks, credentials, meta, channels, events24h, deliveries, lastEvent, emailConn] = await Promise.all([
        tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } }),
        tx.webhookEndpoint.findMany({ orderBy: { createdAt: "asc" } }),
        tx.integrationCredential.findMany({ where: { provider: "clariva" } }),
        tx.metaBusinessConnection.findUnique({ where: { organizationId: ctx.organizationId } }),
        tx.channelConnection.findMany(),
        tx.integrationEvent.count({ where: { createdAt: { gte: since24h } } }),
        tx.webhookDelivery.findMany({
          where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
          select: { endpointId: true, status: true, createdAt: true },
        }),
        tx.integrationEvent.findFirst({ orderBy: { createdAt: "desc" } }),
        tx.integrationConnection.findUnique({ where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "email" } } }),
      ]);

      // Avisar en la campana a quienes pidieron "Avisarme" de tarjetas ya disponibles.
      await this.notifyInterested(tx, ctx.organizationId, ["email"], { email: "Correo electrónico" }).catch(() => undefined);

      const cred = scheduling?.credentialId ? credentials.find((c) => c.id === scheduling.credentialId) : null;
      const failing = deliveries.filter((d) => d.status === "FAILED" || d.status === "DEAD");

      const clarivaActive = scheduling?.status === "active";
      const metaConnected = meta?.status === "CONNECTED";
      const activeChannels = channels.filter((c) => c.status === "active").length;
      const activeWebhooks = webhooks.filter((w) => w.active).length;

      const attention =
        (scheduling?.lastError ? 1 : 0) +
        (meta?.status === "ERROR" ? 1 : 0) +
        (failing.length > 0 ? 1 : 0);

      return {
        metrics: {
          active: (clarivaActive ? 1 : 0) + (metaConnected ? 1 : 0) + activeChannels + activeWebhooks,
          attention,
          events24h,
          webhookErrors7d: failing.length,
          lastActivityAt: lastEvent?.createdAt ?? null,
          lastSyncAt: scheduling?.lastSyncAt ?? null,
        },
        meta: meta
          ? { status: meta.status, mode: meta.mode, businessName: meta.businessName, lastError: meta.lastError }
          : null,
        clariva: scheduling
          ? {
              status: scheduling.status,
              baseUrl: (scheduling.config as any)?.baseUrl ?? null,
              apiKeyMasked: cred ? maskSecret(decryptSecret(cred.ciphertext)) : null,
              lastSyncAt: scheduling.lastSyncAt,
              lastError: scheduling.lastError,
            }
          : null,
        email: emailConn
          ? {
              status: emailConn.status,
              lastError: emailConn.lastError,
              lastCheckAt: emailConn.lastSyncAt,
              ...((emailConn.config as Record<string, unknown>) ?? {}),
              smtp: (emailConn.config as any)?.smtp
                ? { ...(emailConn.config as any).smtp, pass: undefined, hasPass: Boolean(emailConn.credentialId) }
                : null,
            }
          : null,
        platformEmailReady: Boolean(getEnv().RESEND_API_KEY),
        webhooks: webhooks.map((w) => {
          const mine = deliveries.filter((d) => d.endpointId === w.id);
          const okCount = mine.filter((d) => d.status === "DELIVERED").length;
          return {
            id: w.id,
            name: w.name,
            description: w.description,
            url: w.url,
            events: w.events,
            active: w.active,
            timeoutMs: w.timeoutMs,
            maxRetries: w.maxRetries,
            secretMasked: maskSecret(w.secret),
            deliveries7d: mine.length,
            successRate: mine.length ? Math.round((okCount / mine.length) * 100) : null,
            lastDeliveryAt: mine.length
              ? mine.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).createdAt
              : null,
          };
        }),
        availableEvents: [...PLATFORM_PUBLIC_EVENTS],
        catalog: [
          { key: "meta", name: "Meta Business Suite", category: "meta", status: "disponible", description: "WhatsApp, Lead Ads, Conversions API, Messenger e Instagram desde una sola conexión.", capabilities: ["WhatsApp Cloud", "Lead Ads", "Conversions API"] },
          { key: "whatsapp", name: "WhatsApp Cloud API", category: "meta", status: "disponible", description: "Recibe y responde mensajes con agentes IA en tu número oficial.", capabilities: ["Mensajes", "Plantillas", "Multi-número"] },
          { key: "meta_leads", name: "Meta Lead Ads", category: "meta", status: "beta", description: "Convierte formularios instantáneos en leads con seguimiento automático.", capabilities: ["Formularios", "Mapeo de campos", "Workflows"] },
          { key: "meta_capi", name: "Meta Conversions API", category: "meta", status: "beta", description: "Devuelve conversiones reales (citas, tratamientos) a tus campañas.", capabilities: ["Eventos", "Deduplicación", "Test events"] },
          { key: "instagram", name: "Instagram Direct", category: "meta", status: "proximamente", description: "Atiende los DM de Instagram con los mismos agentes.", capabilities: ["Mensajes"] },
          { key: "messenger", name: "Facebook Messenger", category: "meta", status: "proximamente", description: "Conversaciones de tu página de Facebook en la misma bandeja.", capabilities: ["Mensajes"] },
          { key: "clariva", name: "Cláriva", category: "agenda", status: "disponible", description: "Agenda clínica: disponibilidad y citas reales de tus sedes.", capabilities: ["Disponibilidad", "Citas", "Sincronización"] },
          { key: "dentalink", name: "Dentalink", category: "agenda", status: "proximamente", description: "Proveedor de agenda dental.", capabilities: ["Disponibilidad", "Citas"] },
          { key: "google_calendar", name: "Google Calendar", category: "agenda", status: "proximamente", description: "Agenda simple para profesionales independientes.", capabilities: ["Eventos"] },
          { key: "custom_scheduling", name: "Agenda personalizada", category: "agenda", status: "proximamente", description: "Conecta tu propio sistema vía el contrato estándar de agenda.", capabilities: ["API"] },
          { key: "webhooks", name: "Webhooks salientes", category: "datos", status: "disponible", description: "Recibe los eventos de Conversia en tus sistemas, firmados HMAC.", capabilities: ["14 eventos", "Reintentos", "Firma HMAC"] },
          { key: "sheets", name: "Google Sheets", category: "datos", status: "proximamente", description: "Exporta leads y citas a planillas.", capabilities: ["Export"] },
          { key: "email", name: "Correo electrónico", category: "datos", status: "disponible", description: "Escalamientos, resúmenes diarios y alertas al equipo (remitente de plataforma o SMTP propio).", capabilities: ["Escalamientos", "Resumen diario", "Alertas", "Paso de workflow"] },
          { key: "custom_api", name: "API personalizada", category: "datos", status: "proximamente", description: "Llama APIs propias desde los workflows.", capabilities: ["Workflows"] },
          { key: "zapier", name: "Zapier", category: "datos", status: "proximamente", description: "Conecta con miles de apps.", capabilities: ["Automatización"] },
          { key: "make", name: "Make", category: "datos", status: "proximamente", description: "Escenarios avanzados de automatización.", capabilities: ["Automatización"] },
          { key: "hubspot", name: "HubSpot", category: "crm", status: "proximamente", description: "Sincroniza contactos y negocios.", capabilities: ["CRM"] },
          { key: "events_manager", name: "Meta Events Manager", category: "crm", status: "proximamente", description: "Métricas de eventos enviados a Meta.", capabilities: ["Analítica"] },
          { key: "ga4", name: "Google Analytics", category: "crm", status: "proximamente", description: "Mide conversiones en tu analítica.", capabilities: ["Analítica"] },
        ],
      };
    });
  }

  /** Feed de actividad/logs de integraciones (payloads sanitizados). */
  @Get("activity")
  activity(@Query("provider") provider?: string, @Query("take") take?: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.integrationEvent.findMany({
        where: provider ? { provider } : undefined,
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(take ?? 50) || 50, 200),
      }),
    );
  }

  /** Campana del panel: incidencias + avisos (integración habilitada). */
  @Get("notifications")
  notifications() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const events = await tx.integrationEvent.findMany({
        where: { OR: [{ status: { in: ["error", "warning"] } }, { type: "integration.enabled" }] },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: { id: true, provider: true, type: true, status: true, message: true, createdAt: true },
      });
      return { events };
    });
  }

  /**
   * Aviso a interesados: si alguien pulsó "Avisarme" en una tarjeta que ya está
   * disponible, deja UNA notificación en la campana (idempotente por key).
   */
  private async notifyInterested(tx: any, organizationId: string, availableKeys: string[], names: Record<string, string>) {
    const interests = await tx.auditLog.findMany({
      where: { action: "integration.interest", entityId: { in: availableKeys } },
      select: { entityId: true },
      distinct: ["entityId"],
    });
    for (const i of interests) {
      const already = await tx.integrationEvent.findFirst({
        where: { type: "integration.enabled", message: { contains: `[${i.entityId}]` } },
        select: { id: true },
      });
      if (already) continue;
      await tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "hub",
          type: "integration.enabled",
          status: "ok",
          message: `🎉 La integración «${names[i.entityId!] ?? i.entityId}» ya está disponible — pediste que te avisáramos. [${i.entityId}]`,
        },
      });
    }
  }

  /** Interés en integraciones "próximamente" (queda auditado). */
  @Post("interest")
  interest(@Body() body: unknown) {
    const ctx = requireContext();
    const input = parse(z.object({ key: z.string().min(2).max(40) }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "integration.interest",
          entityType: "integration",
          entityId: input.key,
        },
      });
      return { ok: true };
    });
  }

  // ------------------------ Correo electrónico ------------------------

  /** Guarda la conexión de correo del tenant (modo plataforma o SMTP propio). */
  @Post("email")
  saveEmail(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(emailSchema, body);
    if (input.mode === "smtp" && !input.smtp?.host) {
      throw new BadRequestException("El modo SMTP requiere host del servidor");
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "email" } },
      });
      // Contraseña SMTP: cifrada como credencial; si no viene, se conserva la anterior.
      let credentialId = existing?.credentialId ?? null;
      if (input.mode === "smtp" && input.smtp?.pass) {
        const credential = await tx.integrationCredential.create({
          data: { organizationId: ctx.organizationId, provider: "email", label: "SMTP del tenant", ciphertext: encryptSecret(input.smtp.pass) },
        });
        credentialId = credential.id;
      }
      if (input.mode === "platform") credentialId = existing?.credentialId ?? null;
      const config = {
        mode: input.mode,
        from: input.from ?? null,
        smtp: input.smtp ? { host: input.smtp.host, port: input.smtp.port, secure: input.smtp.secure, user: input.smtp.user } : null,
        escalation: input.escalation,
        dailySummary: { ...input.dailySummary, lastSentDate: ((existing?.config as any)?.dailySummary?.lastSentDate ?? null) },
        alerts: input.alerts,
      } as object;
      const saved = existing
        ? await tx.integrationConnection.update({ where: { id: existing.id }, data: { config, credentialId, status: "active", lastError: null } })
        : await tx.integrationConnection.create({
            data: { organizationId: ctx.organizationId, provider: "email", config, credentialId, status: "active" },
          });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email_save", entityType: "integration_connection", entityId: saved.id, after: { mode: input.mode } },
      });
      return { ok: true };
    });
  }

  /** Prueba real: envía un correo de prueba con la config guardada. */
  @Post("email/test")
  async testEmail(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ to: z.string().email() }), body);
    const data = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "email" } },
      });
      const cfg = (conn?.config as Record<string, any>) ?? { mode: "platform" };
      let pass = "";
      if (conn?.credentialId) {
        const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
        if (cred) pass = decryptSecret(cred.ciphertext);
      }
      return { conn, cfg, pass };
    });

    const subject = "Correo de prueba — TuBot";
    const html = "<p>✔ La conexión de correo de tu organización funciona correctamente.</p>";
    let ok = false;
    let detail = "";
    try {
      if (data.cfg.mode === "smtp" && data.cfg.smtp?.host) {
        const nodemailer = await import("nodemailer");
        const transport = nodemailer.createTransport({
          host: data.cfg.smtp.host,
          port: Number(data.cfg.smtp.port ?? 587),
          secure: Boolean(data.cfg.smtp.secure),
          auth: data.cfg.smtp.user ? { user: data.cfg.smtp.user, pass: data.pass } : undefined,
          connectionTimeout: 10_000,
        });
        await transport.sendMail({ from: data.cfg.from ?? data.cfg.smtp.user, to: input.to, subject, html });
        ok = true;
        detail = `Correo de prueba enviado a ${input.to} por tu SMTP`;
      } else {
        ok = await sendPlatformEmail({ to: input.to, subject, html });
        detail = ok
          ? `Correo de prueba enviado a ${input.to} por el remitente de plataforma`
          : "El remitente de plataforma no está configurado (RESEND_API_KEY)";
      }
    } catch (err) {
      detail = (err as Error).message.slice(0, 300);
    }
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      if (data.conn) {
        await tx.integrationConnection.update({
          where: { id: data.conn.id },
          data: { lastSyncAt: new Date(), status: ok ? "active" : "error", lastError: ok ? null : detail },
        });
      }
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "email", type: ok ? "email.test_ok" : "email.test_error", status: ok ? "ok" : "error", message: detail },
      });
    });
    return { ok, detail };
  }

  /** Desconecta el correo (los avisos y el paso de workflow dejarán de enviarse). */
  @Delete("email")
  disconnectEmail() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.integrationConnection.deleteMany({ where: { provider: "email" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email_disconnect", entityType: "integration_connection" },
      });
      return { ok: true };
    });
  }

  // ---------------------------- Cláriva ----------------------------

  @Post("clariva")
  connectClariva(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(clarivaSchema, body);
    assertUrlAllowed(input.baseUrl);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const credential = await tx.integrationCredential.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "clariva",
          label: "API key Cláriva",
          ciphertext: encryptSecret(input.apiKey),
        },
      });
      const existing = await tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } });
      const connection = existing
        ? await tx.schedulingConnection.update({
            where: { id: existing.id },
            data: { status: "active", config: { baseUrl: input.baseUrl }, credentialId: credential.id, lastError: null },
          })
        : await tx.schedulingConnection.create({
            data: {
              organizationId: ctx.organizationId,
              provider: "CLARIVA",
              status: "active",
              config: { baseUrl: input.baseUrl },
              credentialId: credential.id,
            },
          });
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "clariva", type: "connection.updated", message: "Credenciales de Cláriva actualizadas" },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.clariva.connect", entityType: "scheduling_connection", entityId: connection.id },
      });
      return { ok: true };
    });
  }

  @Post("clariva/test")
  async testClariva() {
    const ctx = requirePermission("integrations:write");
    const config = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const connection = await tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } });
      if (!connection) throw new BadRequestException("Cláriva no está conectado");
      const cred = connection.credentialId
        ? await tx.integrationCredential.findUnique({ where: { id: connection.credentialId } })
        : null;
      return {
        connectionId: connection.id,
        baseUrl: (connection.config as any)?.baseUrl as string,
        apiKey: cred ? decryptSecret(cred.ciphertext) : "",
      };
    });

    try {
      const provider = new ClarivaSchedulingProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
      const clinics = await provider.getClinics();
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.schedulingConnection.update({
          where: { id: config.connectionId },
          data: { lastSyncAt: new Date(), lastError: null },
        });
        await tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "clariva", type: "sync.ok", message: `${clinics.length} sede(s) visibles` },
        });
      });
      return { ok: true, detail: `Conexión OK — ${clinics.length} sede(s): ${clinics.map((c) => c.name).join(", ")}` };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.schedulingConnection.update({ where: { id: config.connectionId }, data: { lastError: message } });
        await tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "clariva", type: "sync.error", status: "error", message },
        });
      });
      return { ok: false, detail: message };
    }
  }

  @Delete("clariva")
  disconnectClariva() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.schedulingConnection.updateMany({
        where: { organizationId: ctx.organizationId, provider: "CLARIVA" },
        data: { status: "inactive" },
      });
      return { ok: true };
    });
  }

  // ---------------------- Webhooks salientes ----------------------

  @Post("webhooks")
  createWebhook(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(webhookSchema, body);
    assertUrlAllowed(input.url);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const secret = `whsec_${randomBytes(18).toString("base64url")}`;
      const webhook = await tx.webhookEndpoint.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          description: input.description ?? null,
          url: input.url,
          secret,
          events: input.events,
          headers: input.headers,
          timeoutMs: input.timeoutMs,
          maxRetries: input.maxRetries,
          active: input.active,
        },
      });
      // El secreto completo se muestra UNA sola vez
      return { id: webhook.id, secret };
    });
  }

  @Patch("webhooks/:id")
  updateWebhook(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(webhookSchema.partial(), body);
    if (input.url) assertUrlAllowed(input.url);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.webhookEndpoint.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("Webhook no encontrado");
      return tx.webhookEndpoint.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.headers !== undefined ? { headers: input.headers } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
    });
  }

  @Post("webhooks/:id/rotate-secret")
  rotateSecret(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const secret = `whsec_${randomBytes(18).toString("base64url")}`;
      await tx.webhookEndpoint.update({ where: { id }, data: { secret } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "webhook.rotate_secret", entityType: "webhook_endpoint", entityId: id },
      });
      return { secret };
    });
  }

  /** Encola una entrega REAL de prueba hacia la URL del webhook. */
  @Post("webhooks/:id/test")
  async testWebhook(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    const delivery = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const endpoint = await tx.webhookEndpoint.findUnique({ where: { id } });
      if (!endpoint) throw new NotFoundException("Webhook no encontrado");
      return tx.webhookDelivery.create({
        data: {
          organizationId: ctx.organizationId,
          endpointId: id,
          event: "test.ping",
          payload: { test: true, message: "Entrega de prueba desde Conversia", occurredAt: new Date().toISOString() },
          status: "PENDING",
        },
      });
    });
    await this.queues.webhooks.add("deliver", { organizationId: ctx.organizationId, deliveryId: delivery.id });
    return { ok: true, deliveryId: delivery.id };
  }

  @Get("webhooks/:id/deliveries")
  deliveries(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.webhookDelivery.findMany({
        where: { endpointId: id },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true,
          event: true,
          status: true,
          attempts: true,
          responseCode: true,
          lastError: true,
          nextRetryAt: true,
          createdAt: true,
        },
      }),
    );
  }

  @Post("webhooks/:id/deliveries/:deliveryId/retry")
  async retryDelivery(@Param("id") id: string, @Param("deliveryId") deliveryId: string) {
    const ctx = requirePermission("integrations:write");
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const delivery = await tx.webhookDelivery.findUnique({ where: { id: deliveryId } });
      if (!delivery || delivery.endpointId !== id) throw new NotFoundException("Entrega no encontrada");
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "PENDING", nextRetryAt: null },
      });
    });
    await this.queues.webhooks.add("deliver", { organizationId: ctx.organizationId, deliveryId });
    return { ok: true };
  }

  @Delete("webhooks/:id")
  removeWebhook(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.webhookDelivery.deleteMany({ where: { endpointId: id } });
      await tx.webhookEndpoint.delete({ where: { id } });
      return { ok: true };
    });
  }
}
