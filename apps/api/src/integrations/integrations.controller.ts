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
import { ClarivaSchedulingProvider, CustomSchedulingProvider, DentalinkSchedulingProvider } from "@conversia/scheduling";
import { PLATFORM_PUBLIC_EVENTS } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { decryptSecret, encryptSecret, maskSecret } from "../common/crypto";
import { sendEmail as sendPlatformEmail } from "../common/email";
import { hashApiKey } from "./developers.controller";
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

/** Conexión de catálogo por proveedor: cada uno con su forma de credenciales. */
const CATALOG_CONNECT_SCHEMA = z.discriminatedUnion("source", [
  z.object({ source: z.literal("woocommerce"), baseUrl: z.string().url(), consumerKey: z.string().min(4), consumerSecret: z.string().min(4) }),
  z.object({ source: z.literal("jumpseller"), login: z.string().min(2), authtoken: z.string().min(8) }),
  z.object({ source: z.literal("fudo"), apiKey: z.string().min(4), apiSecret: z.string().min(4) }),
  z.object({ source: z.literal("shopify"), shop: z.string().min(3), token: z.string().min(10) }),
  z.object({ source: z.literal("bsale"), token: z.string().min(10) }),
]);

/** Normaliza el dominio de una tienda Shopify a https://{tienda}.myshopify.com. */
function shopifyBaseUrl(shop: string): string {
  const host = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  if (!host.endsWith(".myshopify.com")) throw new BadRequestException("El dominio debe ser tutienda.myshopify.com");
  return `https://${host}`;
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
      const [scheduling, customSched, dentalinkConn, webhooks, credentials, meta, channels, events24h, deliveries, lastEvent, emailConn] = await Promise.all([
        tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } }),
        tx.schedulingConnection.findFirst({ where: { provider: "CUSTOM" } }),
        tx.schedulingConnection.findFirst({ where: { provider: "DENTALINK" } }),
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
      const metaCrm = await tx.metaCrmConnection.findUnique({ where: { organizationId: ctx.organizationId } });
      const presetsConn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
      const presetCount = (((presetsConn?.config as any)?.presets ?? []) as any[]).length;
      const ga4Conn = await tx.integrationConnection.findFirst({ where: { provider: "ga4" } });
      const googleConn = await tx.integrationConnection.findFirst({ where: { provider: "google" } });
      const platformGoogleReady = Boolean(getEnv().GOOGLE_OAUTH_CLIENT_ID && getEnv().GOOGLE_OAUTH_CLIENT_SECRET);
      const hubspotConn = await tx.integrationConnection.findFirst({ where: { provider: "hubspot" } });
      const platformHubspotReady = Boolean(getEnv().HUBSPOT_CLIENT_ID && getEnv().HUBSPOT_CLIENT_SECRET);

      // Avisar en la campana a quienes pidieron "Avisarme" de tarjetas ya disponibles.
      await this.notifyInterested(
        tx,
        ctx.organizationId,
        ["email", "custom_api", "ga4", "events_manager", "custom_scheduling", "zapier", "make", "dentalink", ...(platformGoogleReady ? ["google_calendar", "sheets"] : []), ...(platformHubspotReady ? ["hubspot"] : [])],
        {
          dentalink: "Dentalink",
          hubspot: "HubSpot",
          email: "Correo electrónico",
          custom_api: "API personalizada",
          ga4: "Google Analytics",
          events_manager: "Meta Events Manager",
          custom_scheduling: "Agenda personalizada",
          zapier: "Zapier",
          make: "Make",
          google_calendar: "Google Calendar",
          sheets: "Google Sheets",
        },
      ).catch(() => undefined);

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
        // Integración SEPARADA: CRM de Lead Ads (app Meta propia, token propio)
        metaCrm: metaCrm
          ? { status: metaCrm.status, mode: metaCrm.mode, businessName: metaCrm.businessName, lastError: metaCrm.lastError }
          : null,
        // Canales de mensajería de página activos (para mostrarlos como Conectadas)
        messagingChannels: {
          messenger: channels.some((c) => c.type === ("MESSENGER" as any) && c.status === "active"),
          instagram: channels.some((c) => c.type === ("INSTAGRAM" as any) && c.status === "active"),
        },
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
        apiPresets: { count: presetCount, status: presetsConn?.status ?? null },
        ga4: ga4Conn
          ? { status: ga4Conn.status, measurementId: (ga4Conn.config as any)?.measurementId ?? null, mirrorCapi: Boolean((ga4Conn.config as any)?.mirrorCapi), lastError: ga4Conn.lastError }
          : null,
        customScheduling: customSched
          ? { status: customSched.status, baseUrl: (customSched.config as any)?.baseUrl ?? null, lastSyncAt: customSched.lastSyncAt, lastError: customSched.lastError }
          : null,
        dentalink: dentalinkConn
          ? {
              status: dentalinkConn.status,
              workStartHour: (dentalinkConn.config as any)?.workStartHour ?? 9,
              workEndHour: (dentalinkConn.config as any)?.workEndHour ?? 19,
              slotMinutes: (dentalinkConn.config as any)?.slotMinutes ?? 30,
              lastSyncAt: dentalinkConn.lastSyncAt,
              lastError: dentalinkConn.lastError,
            }
          : null,
        capiConfigured: Boolean((await tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } }))?.datasetId),
        platformGoogleReady,
        platformHubspotReady,
        hubspot: hubspotConn
          ? {
              status: hubspotConn.status,
              accountEmail: (hubspotConn.config as any)?.accountEmail ?? null,
              hubDomain: (hubspotConn.config as any)?.hubDomain ?? null,
              syncAuto: (hubspotConn.config as any)?.syncAuto !== false,
              fieldMapping: (hubspotConn.config as any)?.fieldMapping ?? null,
              lastSyncAt: hubspotConn.lastSyncAt,
              lastError: hubspotConn.lastError,
            }
          : null,
        google: googleConn
          ? {
              status: googleConn.status,
              accountEmail: (googleConn.config as any)?.accountEmail ?? null,
              calendarId: (googleConn.config as any)?.calendarId ?? null,
              calendarSync: Boolean((googleConn.config as any)?.calendarSync),
              lastSyncAt: googleConn.lastSyncAt,
              lastError: googleConn.lastError,
            }
          : null,
        automations: {
          zapier: await tx.integrationConnection
            .findUnique({ where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "zapier" } } })
            .then((c) => (c ? { status: c.status, webhookEndpointId: (c.config as any)?.webhookEndpointId ?? null } : null)),
          make: await tx.integrationConnection
            .findUnique({ where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "make" } } })
            .then((c) => (c ? { status: c.status, webhookEndpointId: (c.config as any)?.webhookEndpointId ?? null } : null)),
        },
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
          { key: "meta_crm", name: "Meta CRM (Lead Ads)", category: "meta", status: "disponible", description: "Leads de formularios directo al CRM y calidad del embudo de vuelta a tus campañas (dataset). Conexión propia, separada de la de WhatsApp/anuncios.", capabilities: ["Formularios → CRM", "lead_id al dataset", "Páginas y formularios"] },
          { key: "meta_leads", name: "Meta Lead Ads", category: "meta", status: "beta", description: "Convierte formularios instantáneos en leads con seguimiento automático.", capabilities: ["Formularios", "Mapeo de campos", "Workflows"] },
          { key: "meta_capi", name: "Meta Conversions API", category: "meta", status: "beta", description: "Devuelve conversiones reales (citas, tratamientos) a tus campañas.", capabilities: ["Eventos", "Deduplicación", "Test events"] },
          { key: "instagram", name: "Instagram", category: "meta", status: "beta", description: "DMs de Instagram en la bandeja, atendidos por los mismos agentes IA. Se activa conectando la página en Meta CRM (la cuenta IG debe estar vinculada a la página).", capabilities: ["Mensajes", "Agentes IA", "Flujos por canal"] },
          { key: "messenger", name: "Messenger", category: "meta", status: "beta", description: "Mensajes de tu página de Facebook en la bandeja, con agentes IA y flujos. Se activa conectando la página en Meta CRM.", capabilities: ["Mensajes", "Agentes IA", "Flujos por canal"] },
          { key: "google_calendar", name: "Google Calendar", category: "agenda", status: platformGoogleReady ? "disponible" : "config_pendiente", description: "Espejo de tus citas de Conversia en el calendario que elijas (OAuth de Google).", capabilities: ["OAuth", "Espejo de citas", "Cancelaciones"] },
          { key: "custom_scheduling", name: "Agenda personalizada", category: "agenda", status: "disponible", description: "Conecta tu propio sistema de reservas implementando el contrato estándar de agenda (HMAC). Los agentes IA lo usan igual que cualquier proveedor.", capabilities: ["Contrato estándar", "HMAC", "Disponibilidad", "Citas"] },
          { key: "clariva", name: "Cláriva", category: "agenda", status: "disponible", description: "Agenda de disponibilidad y citas reales de tus sedes.", capabilities: ["Disponibilidad", "Citas", "Sincronización"] },
          { key: "dentalink", name: "Dentalink", category: "agenda", status: "disponible", description: "Agenda dental de Healthatom (para clínicas): horas reales y agendamiento directo.", capabilities: ["Token API", "Disponibilidad", "Citas"] },
          { key: "webhooks", name: "Webhooks salientes", category: "datos", status: "disponible", description: "Recibe los eventos de Conversia en tus sistemas, firmados HMAC.", capabilities: ["14 eventos", "Reintentos", "Firma HMAC"] },
          { key: "sheets", name: "Google Sheets", category: "datos", status: platformGoogleReady ? "disponible" : "config_pendiente", description: "Agrega filas a tus planillas desde los flujos (paso «Agregar fila a Google Sheets»).", capabilities: ["OAuth", "Paso de workflow", "Variables"] },
          { key: "email", name: "Correo electrónico", category: "datos", status: "disponible", description: "Escalamientos, resúmenes diarios y alertas al equipo (remitente de plataforma o SMTP propio).", capabilities: ["Escalamientos", "Resumen diario", "Alertas", "Paso de workflow"] },
          { key: "custom_api", name: "API personalizada", category: "datos", status: "disponible", description: "Presets de tus APIs (URL + auth cifrada) para usarlos en el paso «Petición HTTP» sin pegar tokens en cada nodo.", capabilities: ["Presets", "Auth cifrada", "Allowlist", "Workflows"] },
          { key: "zapier", name: "Zapier", category: "datos", status: "disponible", description: "Asistente guiado: trigger con nuestros webhooks + acciones con la API de Conversia (sin app nativa).", capabilities: ["Asistente", "Webhook + API key", "Plantillas"] },
          { key: "make", name: "Make", category: "datos", status: "disponible", description: "Asistente guiado: escenarios de Make con nuestros webhooks y API (sin app nativa).", capabilities: ["Asistente", "Webhook + API key", "Plantillas"] },
          { key: "hubspot", name: "HubSpot", category: "crm", status: platformHubspotReady ? "disponible" : "config_pendiente", description: "Sincroniza tus contactos de Conversia a HubSpot (unidireccional, sin duplicados, con mapeo de campos).", capabilities: ["OAuth", "Contactos", "Backfill", "Sin duplicados"] },
          { key: "events_manager", name: "Meta Events Manager", category: "crm", status: "disponible", description: "Métricas de los eventos CAPI: envíos por día y por tipo, tasa de éxito y últimos rechazos de Meta.", capabilities: ["Métricas", "Errores", "Link directo"] },
          { key: "ga4", name: "Google Analytics", category: "crm", status: "disponible", description: "Eventos GA4 desde los flujos y espejo automático de las conversiones CAPI (Measurement Protocol, sin OAuth).", capabilities: ["Paso de workflow", "Espejo CAPI", "Prueba con validación"] },
          // Catálogo comercial: el bot vende con productos/precios/stock reales de la tienda o el menú.
          { key: "woocommerce", name: "WooCommerce", category: "comercio", status: "beta", description: "Sincroniza los productos, precios y stock reales de tu tienda WooCommerce para que el bot venda con datos vivos.", capabilities: ["Productos", "Precios", "Stock", "Búsqueda por IA"] },
          { key: "shopify", name: "Shopify", category: "comercio", status: "beta", description: "Catálogo de tu tienda Shopify (productos, variantes, precios y stock) para vender por WhatsApp.", capabilities: ["Productos", "Variantes", "Stock"] },
          { key: "jumpseller", name: "Jumpseller", category: "comercio", status: "beta", description: "Tu catálogo de Jumpseller (muy usado en Chile) conectado al bot.", capabilities: ["Productos", "Precios", "Stock"] },
          { key: "bsale", name: "Bsale", category: "comercio", status: "beta", description: "Productos, precios y stock de Bsale para cotizar y vender con datos reales.", capabilities: ["Productos", "Stock", "Precios"] },
          { key: "fudo", name: "Fudo", category: "comercio", status: "beta", description: "El menú de tu restaurante en Fudo (secciones, productos y disponibilidad) para que el bot venda con datos reales.", capabilities: ["Menú", "Secciones", "Disponibilidad"] },
          { key: "catalog_csv", name: "Importar por CSV", category: "comercio", status: "proximamente", description: "¿Sin tienda conectada? Sube tu catálogo por planilla con una plantilla y mapeo de columnas.", capabilities: ["Plantilla", "Mapeo", "Manual"] },
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
      // Preferencia personal: si el usuario silenció los errores de integraciones,
      // la campana solo muestra los avisos informativos (integration.enabled).
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
      const prefs = ((((org?.settings ?? {}) as Record<string, any>).notifPrefs ?? {}) as Record<string, any>)[ctx.userId] ?? {};
      const wantErrors = prefs.integrationError !== false;
      const events = await tx.integrationEvent.findMany({
        where: wantErrors ? { OR: [{ status: { in: ["error", "warning"] } }, { type: "integration.enabled" }] } : { type: "integration.enabled" },
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

  // ------------------------ Zapier / Make (asistente guiado) ------------------------

  /**
   * Conecta Zapier o Make sobre lo que ya existe: crea (o reusa) un webhook
   * saliente hacia su URL "catch" + una API key con scopes de contactos.
   * Los secretos se muestran UNA sola vez.
   */
  @Post("automation")
  async connectAutomation(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({
        kind: z.enum(["zapier", "make"]),
        webhookUrl: z.string().url(),
        events: z.array(z.string()).min(1).default(["lead.created", "appointment.created", "lead.status_changed"]),
      }),
      body,
    );
    assertUrlAllowed(input.webhookUrl);
    const label = input.kind === "zapier" ? "Zapier" : "Make";
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: ctx.organizationId, provider: input.kind } },
      });
      // 1) Webhook saliente hacia el catch de Zapier/Make (reusa si ya existe)
      const cfg = (existing?.config as Record<string, any>) ?? {};
      let endpointId: string | null = cfg.webhookEndpointId ?? null;
      let webhookSecret: string | null = null;
      const endpoint = endpointId ? await tx.webhookEndpoint.findUnique({ where: { id: endpointId } }) : null;
      if (endpoint) {
        await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { url: input.webhookUrl, events: input.events, active: true } });
      } else {
        webhookSecret = `whsec_${randomBytes(24).toString("base64url")}`;
        const created = await tx.webhookEndpoint.create({
          data: {
            organizationId: ctx.organizationId,
            name: label,
            description: `Conector ${label} (creado por el asistente)`,
            url: input.webhookUrl,
            secret: webhookSecret,
            events: input.events,
          },
        });
        endpointId = created.id;
      }
      // 2) API key para las acciones (consultar/crear contactos desde ${label})
      let apiKeyId: string | null = cfg.apiKeyId ?? null;
      let apiKeySecret: string | null = null;
      const key = apiKeyId ? await tx.apiKey.findUnique({ where: { id: apiKeyId } }) : null;
      if (!key || key.revokedAt) {
        apiKeySecret = `cnvk_${randomBytes(24).toString("base64url")}`;
        const createdKey = await tx.apiKey.create({
          data: {
            organizationId: ctx.organizationId,
            name: label,
            prefix: apiKeySecret.slice(0, 12),
            hash: hashApiKey(apiKeySecret),
            scopes: ["contacts:read", "contacts:write"],
            createdById: ctx.userId,
          },
        });
        apiKeyId = createdKey.id;
      }
      // 3) Conexión
      const config = { webhookEndpointId: endpointId, apiKeyId } as object;
      if (existing) {
        await tx.integrationConnection.update({ where: { id: existing.id }, data: { config, status: "active", lastError: null } });
      } else {
        await tx.integrationConnection.create({ data: { organizationId: ctx.organizationId, provider: input.kind, config } });
      }
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: `integration.${input.kind}_connect`, entityType: "integration_connection", after: { webhookUrl: input.webhookUrl } },
      });
      return { ok: true, webhookSecret, apiKeySecret };
    });
  }

  @Delete("automation/:kind")
  disconnectAutomation(@Param("kind") kind: string) {
    const ctx = requirePermission("integrations:write");
    if (kind !== "zapier" && kind !== "make") throw new BadRequestException("Integración desconocida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: ctx.organizationId, provider: kind } },
      });
      const cfg = (conn?.config as Record<string, any>) ?? {};
      if (cfg.webhookEndpointId) {
        await tx.webhookEndpoint.updateMany({ where: { id: cfg.webhookEndpointId }, data: { active: false } });
      }
      if (cfg.apiKeyId) {
        await tx.apiKey.updateMany({ where: { id: cfg.apiKeyId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await tx.integrationConnection.deleteMany({ where: { provider: kind } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: `integration.${kind}_disconnect`, entityType: "integration_connection" },
      });
      return { ok: true };
    });
  }

  // ------------------------ Agenda personalizada (contrato estándar) ------------------------

  /** Conecta el sistema de agenda propio del tenant (contrato estándar + HMAC). */
  @Post("custom-scheduling")
  saveCustomScheduling(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ baseUrl: z.string().url(), secret: z.string().min(12).max(200).optional() }), body);
    assertUrlAllowed(input.baseUrl);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.schedulingConnection.findFirst({ where: { provider: "CUSTOM" } });
      const other = await tx.schedulingConnection.findFirst({ where: { provider: { not: "CUSTOM" }, status: "active" } });
      if (other) {
        throw new BadRequestException("Ya hay otra agenda activa (Cláriva/otro proveedor). Desconéctala antes de usar la personalizada.");
      }
      let credentialId = existing?.credentialId ?? null;
      if (input.secret) {
        const credential = await tx.integrationCredential.create({
          data: { organizationId: ctx.organizationId, provider: "custom_scheduling", label: "Secreto HMAC agenda", ciphertext: encryptSecret(input.secret) },
        });
        credentialId = credential.id;
      }
      if (!credentialId) throw new BadRequestException("Falta el secreto HMAC");
      if (existing) {
        await tx.schedulingConnection.update({
          where: { id: existing.id },
          data: { config: { baseUrl: input.baseUrl } as object, credentialId, status: "active", lastError: null },
        });
      } else {
        await tx.schedulingConnection.create({
          data: { organizationId: ctx.organizationId, provider: "CUSTOM", config: { baseUrl: input.baseUrl } as object, credentialId },
        });
      }
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.custom_scheduling_save", entityType: "scheduling_connection", after: { baseUrl: input.baseUrl } },
      });
      return { ok: true };
    });
  }

  /** Prueba real: pide profesionales y disponibilidad de ejemplo al sistema del tenant. */
  @Post("custom-scheduling/test")
  async testCustomScheduling() {
    const ctx = requirePermission("integrations:write");
    const data = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.schedulingConnection.findFirst({ where: { provider: "CUSTOM" } });
      if (!conn) throw new BadRequestException("La agenda personalizada no está conectada");
      const cred = conn.credentialId ? await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } }) : null;
      return { conn, baseUrl: (conn.config as any)?.baseUrl as string, secret: cred ? decryptSecret(cred.ciphertext) : "" };
    });
    const provider = new CustomSchedulingProvider({ baseUrl: data.baseUrl, secret: data.secret });
    let ok = false;
    let detail = "";
    try {
      const professionals = await provider.getProfessionals();
      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const slots = await provider.getAvailableSlots({ from, to, professionalId: professionals[0]?.id });
      ok = true;
      detail = `✔ ${professionals.length} profesional(es) · ${slots.length} horario(s) disponibles esta semana`;
    } catch (err) {
      detail = (err as Error).message.slice(0, 300);
    }
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.schedulingConnection.update({
        where: { id: data.conn.id },
        data: { lastSyncAt: new Date(), status: ok ? "active" : "error", lastError: ok ? null : detail },
      });
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "custom_scheduling", type: ok ? "agenda.test_ok" : "agenda.test_error", status: ok ? "ok" : "error", message: detail },
      });
    });
    return { ok, detail };
  }

  @Delete("custom-scheduling")
  disconnectCustomScheduling() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.schedulingConnection.deleteMany({ where: { provider: "CUSTOM" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.custom_scheduling_disconnect", entityType: "scheduling_connection" },
      });
      return { ok: true };
    });
  }

  // ------------------------ Dentalink (Healthatom) ------------------------

  /** Conecta Dentalink: token de la sección «Configuración API» de Dentalink. */
  @Post("dentalink")
  saveDentalink(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({
        token: z.string().min(10).max(500).optional(),
        workStartHour: z.number().int().min(0).max(23).optional(),
        workEndHour: z.number().int().min(1).max(24).optional(),
        slotMinutes: z.number().int().min(10).max(120).optional(),
      }),
      body,
    );
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.schedulingConnection.findFirst({ where: { provider: "DENTALINK" } });
      const other = await tx.schedulingConnection.findFirst({ where: { provider: { not: "DENTALINK" }, status: "active" } });
      if (other) {
        throw new BadRequestException("Ya hay otra agenda activa (Cláriva/personalizada). Desconéctala antes de usar Dentalink.");
      }
      let credentialId = existing?.credentialId ?? null;
      if (input.token) {
        const credential = await tx.integrationCredential.create({
          data: { organizationId: ctx.organizationId, provider: "dentalink", label: "Token API Dentalink", ciphertext: encryptSecret(input.token) },
        });
        credentialId = credential.id;
      }
      if (!credentialId) throw new BadRequestException("Falta el token de la API de Dentalink");
      const config = {
        workStartHour: input.workStartHour ?? (existing?.config as any)?.workStartHour ?? 9,
        workEndHour: input.workEndHour ?? (existing?.config as any)?.workEndHour ?? 19,
        slotMinutes: input.slotMinutes ?? (existing?.config as any)?.slotMinutes ?? 30,
        utcOffset: "-04:00",
      } as object;
      if (existing) {
        await tx.schedulingConnection.update({
          where: { id: existing.id },
          data: { config, credentialId, status: "active", lastError: null },
        });
      } else {
        await tx.schedulingConnection.create({
          data: { organizationId: ctx.organizationId, provider: "DENTALINK", config, credentialId },
        });
      }
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.dentalink_save", entityType: "scheduling_connection" },
      });
      return { ok: true };
    });
  }

  /** Prueba real contra Dentalink: sucursales + dentistas habilitados. */
  @Post("dentalink/test")
  async testDentalink() {
    const ctx = requirePermission("integrations:write");
    const data = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.schedulingConnection.findFirst({ where: { provider: "DENTALINK" } });
      if (!conn) throw new BadRequestException("Dentalink no está conectado");
      const cred = conn.credentialId ? await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } }) : null;
      return { conn, token: cred ? decryptSecret(cred.ciphertext) : "" };
    });
    const provider = new DentalinkSchedulingProvider({ token: data.token });
    let ok = false;
    let detail = "";
    try {
      const [clinics, professionals] = await Promise.all([provider.getClinics(), provider.getProfessionals()]);
      ok = true;
      detail = `✔ ${clinics.length} sucursal(es) · ${professionals.length} dentista(s) habilitados — ${clinics
        .slice(0, 3)
        .map((c) => c.name)
        .join(", ")}`;
    } catch (err) {
      detail = (err as Error).message.slice(0, 300);
    }
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.schedulingConnection.update({
        where: { id: data.conn.id },
        data: { lastSyncAt: new Date(), status: ok ? "active" : "error", lastError: ok ? null : detail },
      });
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "dentalink", type: ok ? "agenda.test_ok" : "agenda.test_error", status: ok ? "ok" : "error", message: detail },
      });
    });
    return { ok, detail };
  }

  @Delete("dentalink")
  disconnectDentalink() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.schedulingConnection.deleteMany({ where: { provider: "DENTALINK" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.dentalink_disconnect", entityType: "scheduling_connection" },
      });
      return { ok: true };
    });
  }

  // ============================ CATÁLOGO COMERCIAL ============================
  // El bot vende con productos/precios/stock reales. La API guarda la conexión y dispara
  // el sync; el motor pesado (paginado) corre en el worker (cola catalog_sync).

  /** Prueba la conexión (feedback inmediato: cuántos productos ve). */
  @Post("catalog/test")
  async catalogTest(@Body() body: unknown) {
    requirePermission("integrations:write");
    const input = parse(CATALOG_CONNECT_SCHEMA, body);
    try {
      if (input.source === "woocommerce") {
        await validateOutboundUrl(input.baseUrl); // guarda anti-SSRF
        const basic = Buffer.from(`${input.consumerKey}:${input.consumerSecret}`).toString("base64");
        const res = await fetch(`${input.baseUrl.replace(/\/$/, "")}/wp-json/wc/v3/products?per_page=1`, { headers: { authorization: `Basic ${basic}`, accept: "application/json" } });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const total = Number(res.headers.get("x-wp-total"));
        return { ok: true, count: Number.isFinite(total) ? total : null };
      }
      if (input.source === "jumpseller") {
        // host fijo de la API central; no requiere validateOutboundUrl
        const u = new URL("https://api.jumpseller.com/v1/products/count.json");
        u.searchParams.set("login", input.login);
        u.searchParams.set("authtoken", input.authtoken);
        const res = await fetch(u.toString(), { headers: { accept: "application/json" } });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const json = (await res.json()) as { count?: number };
        const count = Number(json?.count);
        return { ok: true, count: Number.isFinite(count) ? count : null };
      }
      if (input.source === "shopify") {
        const baseUrl = shopifyBaseUrl(input.shop);
        await validateOutboundUrl(baseUrl); // guarda anti-SSRF
        const res = await fetch(`${baseUrl}/admin/api/2025-04/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": input.token, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: "{ shop { name } }" }),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const json = (await res.json()) as { data?: { shop?: { name?: string } }; errors?: unknown };
        if (json.errors || !json.data?.shop) return { ok: false, error: "Token o permisos inválidos" };
        return { ok: true, count: null };
      }
      if (input.source === "bsale") {
        const res = await fetch("https://api.bsale.io/v1/products.json?limit=1", { headers: { access_token: input.token, accept: "application/json" } });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const json = (await res.json()) as { count?: number };
        const count = Number(json?.count);
        return { ok: true, count: Number.isFinite(count) ? count : null };
      }
      // fudo: intercambia apiKey/apiSecret por token y consulta el menú
      const auth = await fetch("https://auth.fu.do/api", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }),
      });
      if (!auth.ok) return { ok: false, error: `Auth Fudo: HTTP ${auth.status}` };
      const token = ((await auth.json()) as { token?: string })?.token;
      if (!token) return { ok: false, error: "Fudo no devolvió token" };
      const res = await fetch("https://api.fu.do/v1alpha1/products?page[size]=1", { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const json = (await res.json()) as { data?: unknown[]; meta?: { totalCount?: number; count?: number } };
      const count = Number(json?.meta?.totalCount ?? json?.meta?.count);
      return { ok: true, count: Number.isFinite(count) ? count : Array.isArray(json?.data) ? json!.data!.length : null };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  }

  /** Guarda la conexión (credenciales cifradas) y dispara la primera sincronización. */
  @Post("catalog/connect")
  async catalogConnect(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(CATALOG_CONNECT_SCHEMA, body);
    const provider = `catalog_${input.source}`;
    let creds: Record<string, string>;
    let config: object;
    if (input.source === "woocommerce") {
      await validateOutboundUrl(input.baseUrl);
      creds = { consumerKey: input.consumerKey, consumerSecret: input.consumerSecret };
      config = { baseUrl: input.baseUrl.replace(/\/$/, "") };
    } else if (input.source === "jumpseller") {
      creds = { login: input.login, authtoken: input.authtoken };
      config = {};
    } else if (input.source === "shopify") {
      const baseUrl = shopifyBaseUrl(input.shop);
      await validateOutboundUrl(baseUrl);
      creds = { token: input.token };
      config = { baseUrl };
    } else if (input.source === "bsale") {
      creds = { token: input.token };
      config = {};
    } else {
      creds = { apiKey: input.apiKey, apiSecret: input.apiSecret };
      config = {};
    }
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const credential = await tx.integrationCredential.create({
        data: { organizationId: ctx.organizationId, provider, label: `Credenciales ${input.source}`, ciphertext: encryptSecret(JSON.stringify(creds)) },
      });
      const existing = await tx.integrationConnection.findFirst({ where: { provider } });
      // Token de webhook (tiempo real capa 1): estable entre reconexiones para no invalidar la URL.
      const prevToken = (existing?.config as { webhookToken?: string } | null)?.webhookToken;
      const cfg = { ...config, webhookToken: prevToken ?? randomBytes(24).toString("base64url") };
      if (existing) await tx.integrationConnection.update({ where: { id: existing.id }, data: { config: cfg, credentialId: credential.id, status: "active", lastError: null } });
      else await tx.integrationConnection.create({ data: { organizationId: ctx.organizationId, provider, config: cfg, credentialId: credential.id } });
      await tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.catalog_connect", entityType: "integration_connection", after: { source: input.source } } });
    });
    await this.queues.sync.add("catalog", { organizationId: ctx.organizationId, kind: "catalog_sync", payload: { source: input.source, mode: "full" } });
    return { ok: true };
  }

  /** Re-sincroniza ahora. */
  @Post("catalog/sync")
  async catalogSync(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ source: z.enum(["woocommerce", "jumpseller", "fudo", "shopify", "bsale"]), mode: z.enum(["full", "incremental"]).optional() }), body);
    const conn = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.integrationConnection.findFirst({ where: { provider: `catalog_${input.source}` } }));
    if (!conn) throw new BadRequestException("Ese catálogo no está conectado");
    await this.queues.sync.add("catalog", { organizationId: ctx.organizationId, kind: "catalog_sync", payload: { source: input.source, mode: input.mode ?? "full" } });
    return { ok: true };
  }

  /** Estado de las conexiones de catálogo + últimas sincronizaciones + total de productos. */
  @Get("catalog/status")
  catalogStatus() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [conns, runs, totalItems] = await Promise.all([
        tx.integrationConnection.findMany({ where: { provider: { startsWith: "catalog_" } } }),
        tx.catalogSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 5 }),
        tx.catalogItem.count({ where: { active: true } }),
      ]);
      const apiUrl = getEnv().API_URL.replace(/\/$/, "");
      return {
        connections: conns.map((c) => {
          const cfg = (c.config as { baseUrl?: string; webhookToken?: string } | null) ?? {};
          return {
            source: c.provider.replace("catalog_", ""),
            status: c.status,
            baseUrl: cfg.baseUrl ?? null,
            lastSyncAt: c.lastSyncAt,
            lastError: c.lastError,
            // URL de webhook (tiempo real): el cliente la pega en su proveedor para actualizaciones al instante.
            webhookUrl: cfg.webhookToken ? `${apiUrl}/hooks/catalog/${cfg.webhookToken}` : null,
          };
        }),
        lastRuns: runs.map((r) => ({ source: r.source, mode: r.mode, status: r.status, created: r.created, updated: r.updated, deactivated: r.deactivated, failed: r.failed, startedAt: r.startedAt, finishedAt: r.finishedAt })),
        totalItems,
      };
    });
  }

  /** Lista el catálogo del tenant (para el módulo de Catálogo): buscar, ver, gestionar. */
  @Get("catalog/items")
  catalogItems(@Query("query") query?: string, @Query("category") category?: string, @Query("page") page?: string) {
    const ctx = requireContext();
    const take = 40;
    const skip = Math.max(0, (Number(page) || 1) - 1) * take;
    const words = (query ?? "").split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const where = {
        ...(category ? { category: { equals: category, mode: "insensitive" as const } } : {}),
        ...(words.length ? { OR: words.flatMap((w) => [{ name: { contains: w, mode: "insensitive" as const } }, { sku: { contains: w, mode: "insensitive" as const } }, { category: { contains: w, mode: "insensitive" as const } }]) } : {}),
      };
      const [rows, total, categories] = await Promise.all([
        tx.catalogItem.findMany({ where, orderBy: [{ available: "desc" }, { name: "asc" }], take, skip }),
        tx.catalogItem.count({ where }),
        tx.catalogItem.findMany({ where: { category: { not: null } }, select: { category: true }, distinct: ["category"], take: 100 }),
      ]);
      return {
        total,
        page: Number(page) || 1,
        categories: categories.map((c) => c.category).filter(Boolean),
        items: rows.map((c) => ({
          id: c.id, name: c.name, sku: c.sku, source: c.source, kind: c.kind, category: c.category,
          price: c.price != null ? Number(c.price) : null, currency: c.currency, available: c.available,
          active: c.active, stock: c.stock, botDescription: c.botDescription, description: c.description, imageUrl: c.imageUrl, productUrl: c.productUrl,
        })),
      };
    });
  }

  /** Gestiona un ítem del catálogo: activar/desactivar para el bot + descripción para el bot. */
  @Patch("catalog/items/:id")
  async updateCatalogItem(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ active: z.boolean().optional(), botDescription: z.string().max(1000).nullable().optional() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const data: Record<string, unknown> = {};
      if (input.active !== undefined) data.active = input.active;
      if (input.botDescription !== undefined) data.botDescription = input.botDescription || null;
      await tx.catalogItem.updateMany({ where: { id }, data });
      return { ok: true };
    });
  }

  /** Importa un catálogo por CSV (para clientes sin tienda conectada). Idempotente por SKU/nombre. */
  @Post("catalog/import-csv")
  async catalogImportCsv(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({
        items: z.array(z.object({
          name: z.string().min(1).max(300),
          sku: z.string().max(100).optional(),
          price: z.coerce.number().min(0).optional(),
          category: z.string().max(120).optional(),
          stock: z.coerce.number().int().optional(),
          description: z.string().max(2000).optional(),
        })).min(1).max(1000),
      }),
      body,
    );
    const org = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { currency: true } }));
    const currency = org?.currency ?? "CLP";
    let created = 0;
    let updated = 0;
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      for (const it of input.items) {
        const externalId = (it.sku || it.name).trim().toLowerCase().slice(0, 120);
        const data = { name: it.name, sku: it.sku ?? null, price: it.price ?? null, category: it.category ?? null, stock: it.stock ?? null, trackStock: it.stock != null, description: it.description ?? null, currency, available: it.stock == null || it.stock > 0 };
        const existing = await tx.catalogItem.findFirst({ where: { source: "csv", externalId }, select: { id: true } });
        if (existing) { await tx.catalogItem.updateMany({ where: { id: existing.id }, data }); updated++; }
        else { await tx.catalogItem.create({ data: { organizationId: ctx.organizationId, source: "csv", externalId, kind: "product", ...data } }); created++; }
      }
    });
    await this.prisma.withTenant(ctx.organizationId, (tx) => tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "catalog.import_csv", entityType: "catalog_item", after: { created, updated } } }));
    // Búsqueda semántica: embebe los ítems importados (si los embeddings están habilitados).
    await this.queues.sync.add("catalog", { organizationId: ctx.organizationId, kind: "catalog_embed", payload: {} }, { jobId: `catalog_embed:${ctx.organizationId}`, delay: 4000, removeOnComplete: true, removeOnFail: 200 }).catch(() => undefined);
    return { ok: true, created, updated };
  }

  // ------------------------ Meta Events Manager (métricas CAPI) ------------------------

  /** Métricas de lo que CAPI ya envía: por día, por evento, errores recientes. */
  @Get("events-manager/stats")
  eventsManagerStats() {
    const ctx = requireContext();
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [mapping, events] = await Promise.all([
        tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } }),
        tx.integrationEvent.findMany({
          where: { provider: "capi", createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take: 2000,
          select: { type: true, status: true, message: true, payload: true, createdAt: true },
        }),
      ]);
      if (!mapping?.datasetId) return { configured: false };

      const byDay = new Map<string, { ok: number; error: number }>();
      const byEvent = new Map<string, { ok: number; error: number }>();
      const recentErrors: { message: string; at: Date }[] = [];
      for (const e of events) {
        const day = e.createdAt.toISOString().slice(0, 10);
        const dest = String((e.payload as any)?.dest ?? "otro");
        const dayAgg = byDay.get(day) ?? { ok: 0, error: 0 };
        const eventAgg = byEvent.get(dest) ?? { ok: 0, error: 0 };
        if (e.status === "ok") {
          dayAgg.ok++;
          eventAgg.ok++;
        } else {
          dayAgg.error++;
          eventAgg.error++;
          if (recentErrors.length < 10 && e.message) recentErrors.push({ message: e.message, at: e.createdAt });
        }
        byDay.set(day, dayAgg);
        byEvent.set(dest, eventAgg);
      }
      const total = events.length;
      const okTotal = events.filter((e) => e.status === "ok").length;
      return {
        configured: true,
        datasetId: mapping.datasetId,
        eventsManagerUrl: `https://business.facebook.com/events_manager2/list/dataset/${mapping.datasetId}`,
        totals: { total, ok: okTotal, error: total - okTotal, successRate: total ? Math.round((okTotal / total) * 100) : null },
        byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
        byEvent: [...byEvent.entries()].map(([event, v]) => ({ event, ...v })).sort((a, b) => b.ok + b.error - (a.ok + a.error)),
        recentErrors,
      };
    });
  }

  // ------------------------ Google Analytics (GA4) ------------------------

  /** Conecta GA4 por Measurement Protocol (measurement_id + api_secret cifrado). */
  @Post("ga4")
  saveGa4(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({
        measurementId: z.string().trim().regex(/^G-[A-Z0-9]{4,16}$/, "Formato G-XXXXXXX"),
        apiSecret: z.string().trim().max(200).optional(),
        mirrorCapi: z.boolean().default(false),
      }),
      body,
    );
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "ga4" } },
      });
      let credentialId = existing?.credentialId ?? null;
      if (input.apiSecret) {
        const credential = await tx.integrationCredential.create({
          data: { organizationId: ctx.organizationId, provider: "ga4", label: "GA4 api_secret", ciphertext: encryptSecret(input.apiSecret) },
        });
        credentialId = credential.id;
      }
      if (!credentialId) throw new BadRequestException("Falta el api_secret (Events Manager → Measurement Protocol)");
      const config = { measurementId: input.measurementId, mirrorCapi: input.mirrorCapi } as object;
      if (existing) {
        await tx.integrationConnection.update({ where: { id: existing.id }, data: { config, credentialId, status: "active", lastError: null } });
      } else {
        await tx.integrationConnection.create({ data: { organizationId: ctx.organizationId, provider: "ga4", config, credentialId } });
      }
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.ga4_save", entityType: "integration_connection", after: { measurementId: input.measurementId, mirrorCapi: input.mirrorCapi } },
      });
      return { ok: true };
    });
  }

  /** Prueba real contra el endpoint de VALIDACIÓN de GA4 (reporta errores de config). */
  @Post("ga4/test")
  async testGa4() {
    const ctx = requirePermission("integrations:write");
    const data = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "ga4" } },
      });
      if (!conn?.credentialId) throw new BadRequestException("GA4 no está conectado");
      const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
      return { conn, measurementId: (conn.config as any)?.measurementId as string, apiSecret: cred ? decryptSecret(cred.ciphertext) : "" };
    });
    let ok = false;
    let detail = "";
    try {
      const res = await fetch(
        `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(data.measurementId)}&api_secret=${encodeURIComponent(data.apiSecret)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: "555.tubot-test", events: [{ name: "tubot_test", params: { engagement_time_msec: 1 } }] }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const json: any = await res.json().catch(() => ({}));
      const messages = (json?.validationMessages ?? []) as { description?: string }[];
      ok = res.ok && messages.length === 0;
      detail = ok
        ? "Evento de prueba válido — GA4 lo aceptará (revisa el informe en tiempo real de Analytics)"
        : messages[0]?.description ?? `GA4 respondió ${res.status}`;
      // Si validó, enviar el evento REAL para verlo en tiempo real en Analytics.
      if (ok) {
        await fetch(
          `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(data.measurementId)}&api_secret=${encodeURIComponent(data.apiSecret)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_id: "555.tubot-test", events: [{ name: "tubot_test", params: { engagement_time_msec: 1 } }] }),
            signal: AbortSignal.timeout(10_000),
          },
        ).catch(() => undefined);
      }
    } catch (err) {
      detail = (err as Error).message.slice(0, 200);
    }
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.integrationConnection.update({
        where: { id: data.conn.id },
        data: { lastSyncAt: new Date(), status: ok ? "active" : "error", lastError: ok ? null : detail },
      });
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "ga4", type: ok ? "ga4.test_ok" : "ga4.test_error", status: ok ? "ok" : "error", message: detail },
      });
    });
    return { ok, detail };
  }

  @Delete("ga4")
  disconnectGa4() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.integrationConnection.deleteMany({ where: { provider: "ga4" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.ga4_disconnect", entityType: "integration_connection" },
      });
      return { ok: true };
    });
  }

  // ------------------------ API personalizada (presets) ------------------------

  /** Presets del paso "Petición HTTP": base URL + auth con secreto cifrado. */
  @Get("api-presets")
  listApiPresets() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
      const presets = (((conn?.config as any)?.presets ?? []) as any[]).map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        authType: p.authType ?? "none",
        headerName: p.headerName ?? null,
        hasSecret: Boolean(p.credentialId),
      }));
      // Qué workflows usan cada preset (búsqueda textual en las definiciones).
      const versions = await tx.workflowVersion.findMany({
        where: { status: { in: ["PUBLISHED", "DRAFT"] } },
        select: { workflowId: true, definition: true },
      });
      const workflows = await tx.workflow.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
      const nameById = new Map(workflows.map((w) => [w.id, w.name]));
      const usage: Record<string, string[]> = {};
      for (const p of presets) {
        const users = new Set<string>();
        for (const v of versions) {
          if (JSON.stringify(v.definition).includes(`"${p.id}"`)) {
            const n = nameById.get(v.workflowId);
            if (n) users.add(n);
          }
        }
        usage[p.id] = [...users];
      }
      return { presets: presets.map((p) => ({ ...p, usedBy: usage[p.id] ?? [] })) };
    });
  }

  /** Crea o actualiza un preset (el secreto se cifra; vacío = conservar). */
  @Post("api-presets")
  saveApiPreset(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({
        id: z.string().optional(),
        name: z.string().trim().min(2).max(60),
        baseUrl: z.string().url(),
        authType: z.enum(["none", "bearer", "header"]).default("none"),
        headerName: z.string().trim().max(60).optional(),
        secret: z.string().max(500).optional(),
      }),
      body,
    );
    assertUrlAllowed(input.baseUrl);
    if (input.authType === "header" && !input.headerName) throw new BadRequestException("Indica el nombre del header de auth");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
      const presets = (((conn?.config as any)?.presets ?? []) as any[]).slice();
      const existing = input.id ? presets.find((p) => p.id === input.id) : null;
      let credentialId = existing?.credentialId ?? null;
      if (input.authType === "none") credentialId = null;
      else if (input.secret) {
        const credential = await tx.integrationCredential.create({
          data: { organizationId: ctx.organizationId, provider: "api_preset", label: `Preset ${input.name}`, ciphertext: encryptSecret(input.secret) },
        });
        credentialId = credential.id;
      }
      if (input.authType !== "none" && !credentialId) throw new BadRequestException("Este tipo de auth requiere un secreto");
      const preset = {
        id: existing?.id ?? randomBytes(6).toString("base64url"),
        name: input.name,
        baseUrl: input.baseUrl,
        authType: input.authType,
        headerName: input.headerName ?? null,
        credentialId,
      };
      const next = existing ? presets.map((p) => (p.id === preset.id ? preset : p)) : [...presets, preset];
      if (next.length > 20) throw new BadRequestException("Máximo 20 presets");
      if (conn) {
        await tx.integrationConnection.update({ where: { id: conn.id }, data: { config: { presets: next } as object, status: "active", lastError: null } });
      } else {
        await tx.integrationConnection.create({
          data: { organizationId: ctx.organizationId, provider: "api_presets", config: { presets: next } as object },
        });
      }
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.api_preset_save", entityType: "integration_connection", entityId: preset.id, after: { name: input.name, baseUrl: input.baseUrl, authType: input.authType } },
      });
      return { ok: true, id: preset.id };
    });
  }

  /** Prueba el preset: GET a la base URL con su auth (vale cualquier 2xx-4xx ≠ 401/403). */
  @Post("api-presets/:id/test")
  async testApiPreset(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    const data = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
      const preset = (((conn?.config as any)?.presets ?? []) as any[]).find((p) => p.id === id);
      if (!preset) throw new NotFoundException("Preset no encontrado");
      let secret = "";
      if (preset.credentialId) {
        const cred = await tx.integrationCredential.findUnique({ where: { id: preset.credentialId } });
        if (cred) secret = decryptSecret(cred.ciphertext);
      }
      return { preset, secret };
    });
    const headers: Record<string, string> = {};
    if (data.preset.authType === "bearer" && data.secret) headers.authorization = `Bearer ${data.secret}`;
    if (data.preset.authType === "header" && data.preset.headerName && data.secret) headers[data.preset.headerName] = data.secret;
    try {
      assertUrlAllowed(data.preset.baseUrl);
      const res = await fetch(data.preset.baseUrl, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      const authOk = res.status !== 401 && res.status !== 403;
      return {
        ok: authOk,
        detail: authOk
          ? `La API respondió ${res.status} — conexión y credenciales OK`
          : `La API respondió ${res.status}: revisa el secreto/las credenciales`,
      };
    } catch (err) {
      return { ok: false, detail: `No se pudo llamar a la API: ${(err as Error).message.slice(0, 200)}` };
    }
  }

  @Delete("api-presets/:id")
  deleteApiPreset(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
      if (!conn) return { ok: true };
      const presets = (((conn.config as any)?.presets ?? []) as any[]).filter((p) => p.id !== id);
      await tx.integrationConnection.update({ where: { id: conn.id }, data: { config: { presets } as object } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.api_preset_delete", entityType: "integration_connection", entityId: id },
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
