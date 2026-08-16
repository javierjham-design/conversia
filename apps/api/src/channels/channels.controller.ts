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
} from "@nestjs/common";
import { z } from "zod";
import { getEnv, withAppSecretProof } from "@conversia/config";
import { TEMPLATE_FIELD_IDS } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret, maskSecret } from "../common/crypto";
import { enforcePlanLimit, getTemplatesEntitlement } from "../common/plan-limits";
import { requirePermission } from "../tenancy/permissions";
import { requireContext } from "../tenancy/context";
import { subscribeAndRegisterWhatsapp } from "./whatsapp-onboard";

const createChannelSchema = z.object({
  type: z.enum(["WHATSAPP_CLOUD", "MOCK"]),
  name: z.string().min(2).max(60),
  defaultAgentId: z.string().nullable().optional(),
  // Solo WHATSAPP_CLOUD:
  phoneNumberId: z.string().min(5).optional(),
  wabaId: z.string().min(3).optional(),
  displayPhone: z.string().optional(),
  accessToken: z.string().min(10).optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  defaultAgentId: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  accessToken: z.string().min(10).optional(),
  // Edición en sitio de los datos de WhatsApp (evita borrar+recrear para cambiar
  // algo o repegar un token que caducó).
  displayPhone: z.string().optional(),
  wabaId: z.string().min(3).optional(),
  phoneNumberId: z.string().min(5).optional(),
});

// Plantillas de mensaje de WhatsApp (HSM) — gestión vía Graph API sobre la WABA
// del canal. Reglas de Meta: nombre snake_case, cuerpo con variables {{1}},{{2}}…
// consecutivas y con valores de ejemplo, pie ≤60, hasta 3 botones de respuesta rápida.
const createTemplateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, "solo minúsculas, números y guion bajo (p. ej. recordatorio_cita)"),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]),
  language: z.string().min(2).max(15).regex(/^[a-z]{2}(_[A-Z]{2})?$/, "código de idioma tipo es, es_MX, en_US"),
  headerText: z.string().trim().max(60).optional(),
  bodyText: z.string().trim().min(1).max(1024),
  footerText: z.string().trim().max(60).optional(),
  bodyExamples: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  quickReplies: z.array(z.string().trim().min(1).max(25)).max(3).optional(),
  // Campo de la plataforma detrás de cada variable {{n}} (posición i = variable i+1),
  // p. ej. ["contact.firstName","appointment.date"]. Se persiste en el config del
  // canal para resolver los valores reales al enviar la plantilla.
  variableFields: z.array(z.enum(TEMPLATE_FIELD_IDS)).max(10).optional(),
});

/** Variables {{n}} del cuerpo; Meta exige que sean consecutivas desde {{1}}. */
function bodyVariableCount(bodyText: string): number {
  const nums = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  if (nums.length === 0) return 0;
  const max = Math.max(...nums);
  for (let i = 1; i <= max; i++) {
    if (!nums.includes(i)) throw new BadRequestException(`Las variables del cuerpo deben ser consecutivas: falta {{${i}}}`);
  }
  return max;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}

@Controller("channels")
export class ChannelsController {
  constructor(private prisma: PrismaService) {}

  /** Datos para configurar el webhook en Meta (por tenant es el mismo endpoint). */
  @Get("meta/webhook-info")
  webhookInfo() {
    requireContext();
    const env = getEnv();
    return {
      webhookUrl: `${env.API_URL}/webhooks/whatsapp`,
      verifyToken: env.META_VERIFY_TOKEN,
      graphVersion: env.META_GRAPH_VERSION,
      fields: ["messages"],
    };
  }

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [channels, numbers, accounts, agents, org] = await Promise.all([
        tx.channelConnection.findMany({ orderBy: { createdAt: "asc" } }),
        tx.whatsappPhoneNumber.findMany(),
        tx.whatsappAccount.findMany({ select: { id: true, wabaId: true } }),
        tx.agent.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
        tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } }),
      ]);
      const agentName = new Map(agents.map((a) => [a.id, a.name]));
      const wabaByAccount = new Map(accounts.map((a) => [a.id, a.wabaId]));
      const defaultReminderChannelId = ((org?.settings as any)?.messaging?.defaultReminderChannelId as string | undefined) ?? null;
      return channels.map((c) => {
        const number = numbers.find((n) => n.channelConnectionId === c.id);
        return {
          id: c.id,
          type: c.type,
          name: c.name,
          status: c.status,
          defaultAgentId: c.defaultAgentId,
          defaultAgentName: c.defaultAgentId ? (agentName.get(c.defaultAgentId) ?? null) : null,
          // Número por defecto para envíos proactivos (recordatorios/plantillas a
          // contactos SIN conversación previa). Configurable por el tenant.
          defaultProactive: c.id === defaultReminderChannelId,
          phoneNumberId: number?.phoneNumberId ?? null,
          displayPhone: number?.displayPhone ?? null,
          wabaId: number ? (wabaByAccount.get(number.accountId) ?? null) : null,
          createdAt: c.createdAt,
        };
      });
    });
  }

  /**
   * Fija el número por defecto para envíos PROACTIVOS (recordatorios/plantillas a
   * contactos sin conversación previa). Regla del envío: si el contacto tiene
   * historial, sale por el mismo número con el que ya habló; si no, por este
   * canal por defecto (o el primero activo si no se configuró). Sin migración
   * (vive en org.settings.messaging.defaultReminderChannelId).
   */
  @Patch("default-proactive")
  async setDefaultProactive(@Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const parsed = z.object({ channelId: z.string().nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("channelId requerido (o null para limpiar)");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const messaging = { ...(settings.messaging ?? {}) };
      if (parsed.data.channelId === null) {
        delete messaging.defaultReminderChannelId;
      } else {
        const ch = await tx.channelConnection.findFirst({ where: { id: parsed.data.channelId, status: "active" } });
        if (!ch) throw new BadRequestException("Canal no encontrado o inactivo");
        messaging.defaultReminderChannelId = parsed.data.channelId;
      }
      await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings: { ...settings, messaging } as object } });
      return { ok: true };
    });
  }

  @Post()
  async create(@Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const input = parse(createChannelSchema, body);

    // WhatsApp Cloud: enganchar el número a Meta ANTES de la transacción (las
    // llamadas de red NO pueden ir dentro de withTenant, que es una tx
    // interactiva). Suscribe la app al WABA (webhooks ENTRANTES) y REGISTRA el
    // número para Cloud API (necesario para ENVIAR; sin esto Meta responde
    // #133010). Antes esto solo lo hacía el Embedded Signup y la conexión manual
    // lo saltaba, dejando el canal a medias. `warnings` avisa si algo falló, sin
    // bloquear la creación del canal.
    let warnings: string[] = [];
    if (input.type === "WHATSAPP_CLOUD") {
      if (!input.phoneNumberId || !input.wabaId || !input.accessToken) {
        throw new BadRequestException("WhatsApp Cloud requiere phoneNumberId, wabaId y accessToken");
      }
      warnings = await subscribeAndRegisterWhatsapp(input.wabaId, input.phoneNumberId, input.accessToken);
    }

    const created = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await enforcePlanLimit(
        tx,
        "channels",
        await tx.channelConnection.count({ where: { status: { not: "inactive" } } }),
      );
      if (input.type === "WHATSAPP_CLOUD") {
        const existing = await tx.whatsappPhoneNumber.findUnique({
          where: { phoneNumberId: input.phoneNumberId! },
        });
        if (existing) throw new BadRequestException("Ese phone_number_id ya está conectado");
      }

      const channel = await tx.channelConnection.create({
        data: {
          organizationId: ctx.organizationId,
          type: input.type,
          name: input.name,
          defaultAgentId: input.defaultAgentId ?? null,
          status: "active",
        },
      });

      if (input.type === "WHATSAPP_CLOUD") {
        const credential = await tx.integrationCredential.create({
          data: {
            organizationId: ctx.organizationId,
            provider: "whatsapp",
            label: `Token ${input.name}`,
            ciphertext: encryptSecret(input.accessToken!),
          },
        });
        const account = await tx.whatsappAccount.upsert({
          where: { organizationId_wabaId: { organizationId: ctx.organizationId, wabaId: input.wabaId! } },
          update: { credentialId: credential.id },
          create: {
            organizationId: ctx.organizationId,
            wabaId: input.wabaId!,
            name: input.name,
            credentialId: credential.id,
          },
        });
        await tx.whatsappPhoneNumber.create({
          data: {
            organizationId: ctx.organizationId,
            accountId: account.id,
            channelConnectionId: channel.id,
            phoneNumberId: input.phoneNumberId!,
            displayPhone: input.displayPhone ?? input.phoneNumberId!,
            status: "active",
          },
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.create",
          entityType: "channel_connection",
          entityId: channel.id,
          after: { type: input.type, name: input.name },
        },
      });
      return channel;
    });
    return { ...created, warnings };
  }

  /** Config pública para el frontend del Embedded Signup (sin secretos). */
  @Get("meta/embedded-config")
  embeddedConfig() {
    requireContext();
    const env = getEnv();
    return {
      appId: env.META_APP_ID,
      configId: env.META_CONFIG_ID,
      graphVersion: env.META_GRAPH_VERSION,
      featureType: env.META_ES_FEATURE_TYPE,
    };
  }

  /**
   * Completa el Embedded Signup: intercambia el code por el token del negocio,
   * suscribe nuestra app a su WABA, registra el número y crea el canal.
   */
  @Post("embedded-signup")
  async embeddedSignup(@Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const env = getEnv();
    const input = parse(
      z.object({
        code: z.string().min(5),
        wabaId: z.string().min(3),
        phoneNumberId: z.string().min(3),
        businessId: z.string().optional(), // negocio (portfolio) elegido en el ES
        name: z.string().min(2).max(60).optional(),
        defaultAgentId: z.string().nullable().optional(),
      }),
      body,
    );
    if (!env.META_APP_ID || !env.META_APP_SECRET) {
      throw new BadRequestException("Embedded Signup no está configurado en el servidor (META_APP_ID / META_APP_SECRET).");
    }
    const v = env.META_GRAPH_VERSION;

    // 1. code -> token del negocio (long-lived en Embedded Signup)
    const tokenRes = await fetch(
      `https://graph.facebook.com/${v}/oauth/access_token?client_id=${encodeURIComponent(env.META_APP_ID)}&client_secret=${encodeURIComponent(env.META_APP_SECRET)}&code=${encodeURIComponent(input.code)}`,
    );
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    const accessToken: string | undefined = tokenJson?.access_token;
    if (!tokenRes.ok || !accessToken) {
      throw new BadRequestException(`No se pudo obtener el token de Meta: ${tokenJson?.error?.message ?? tokenRes.status}`);
    }

    // 2. Suscribir nuestra app al WABA del cliente (webhooks) — best-effort
    await fetch(withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(input.wabaId)}/subscribed_apps`, accessToken), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);

    // 3. Registrar el número para Cloud API — best-effort (puede estar ya registrado)
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    await fetch(withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(input.phoneNumberId)}/register`, accessToken), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    }).catch(() => undefined);

    // 4. Nombre visible del número — best-effort
    let displayPhone = input.phoneNumberId;
    try {
      const numRes = await fetch(
        withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(input.phoneNumberId)}?fields=display_phone_number,verified_name`, accessToken),
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      const numJson: any = await numRes.json();
      if (numRes.ok && numJson?.display_phone_number) displayPhone = numJson.display_phone_number;
    } catch {
      /* ignore */
    }

    // 4b. Nombre del negocio (portfolio) que el usuario eligió en el Embedded
    // Signup — best-effort, solo para mostrarlo/registrarlo (multi-negocio).
    let businessName: string | null = null;
    if (input.businessId) {
      try {
        const bRes = await fetch(
          withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(input.businessId)}?fields=name`, accessToken),
          { headers: { authorization: `Bearer ${accessToken}` } },
        );
        const bJson: any = await bRes.json();
        if (bRes.ok && bJson?.name) businessName = bJson.name;
      } catch {
        /* ignore */
      }
    }
    // 4c. Id del usuario/negocio de Meta que autorizó — para mapear el
    // callback de desautorización de la app (deauthorize) a este canal.
    let metaUserId: string | null = null;
    try {
      const meRes = await fetch(withAppSecretProof(`https://graph.facebook.com/${v}/me?fields=id`, accessToken), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const meJson: any = await meRes.json();
      if (meRes.ok && meJson?.id) metaUserId = String(meJson.id);
    } catch {
      /* ignore */
    }
    const name = input.name ?? `WhatsApp ${displayPhone}`;

    // 5. Persistir el canal con el token por-WABA cifrado
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.whatsappPhoneNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId } });

      // Re-onboarding idempotente: si ESTE tenant ya tiene el número (bajo RLS solo
      // ve los suyos), refrescamos el token y reactivamos el canal en vez de fallar.
      if (existing) {
        const credential = await tx.integrationCredential.create({
          data: {
            organizationId: ctx.organizationId,
            provider: "whatsapp",
            label: `Token Embedded Signup ${name} (reconexión)`,
            ciphertext: encryptSecret(accessToken),
          },
        });
        await tx.whatsappAccount.updateMany({
          where: { organizationId: ctx.organizationId, wabaId: input.wabaId },
          data: { credentialId: credential.id, ...(input.businessId ? { businessId: input.businessId } : {}) },
        });
        if (existing.channelConnectionId) {
          const cc = await tx.channelConnection.findUnique({ where: { id: existing.channelConnectionId }, select: { config: true } });
          await tx.channelConnection.update({
            where: { id: existing.channelConnectionId },
            data: {
              status: "active",
              ...(input.defaultAgentId ? { defaultAgentId: input.defaultAgentId } : {}),
              ...(metaUserId ? { config: { ...((cc?.config as Record<string, unknown>) ?? {}), metaUserId } } : {}),
            },
          });
        }
        await tx.auditLog.create({
          data: {
            organizationId: ctx.organizationId,
            actorType: "user",
            actorId: ctx.userId,
            action: "channel.embedded_signup_reconnect",
            entityType: "channel_connection",
            entityId: existing.channelConnectionId ?? existing.id,
            after: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId },
          },
        });
        return { ok: true, id: existing.channelConnectionId, name, displayPhone, businessName, reconnected: true };
      }

      await enforcePlanLimit(tx, "channels", await tx.channelConnection.count({ where: { status: { not: "inactive" } } }));
      const channel = await tx.channelConnection.create({
        data: {
          organizationId: ctx.organizationId,
          type: "WHATSAPP_CLOUD",
          name,
          defaultAgentId: input.defaultAgentId ?? null,
          status: "active",
          ...(metaUserId ? { config: { metaUserId } } : {}),
        },
      });
      const credential = await tx.integrationCredential.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "whatsapp",
          label: `Token Embedded Signup ${name}`,
          ciphertext: encryptSecret(accessToken),
        },
      });
      const account = await tx.whatsappAccount.upsert({
        where: { organizationId_wabaId: { organizationId: ctx.organizationId, wabaId: input.wabaId } },
        update: { credentialId: credential.id, ...(input.businessId ? { businessId: input.businessId } : {}) },
        create: { organizationId: ctx.organizationId, wabaId: input.wabaId, businessId: input.businessId ?? null, name, credentialId: credential.id },
      });
      await tx.whatsappPhoneNumber.create({
        data: {
          organizationId: ctx.organizationId,
          accountId: account.id,
          channelConnectionId: channel.id,
          phoneNumberId: input.phoneNumberId,
          displayPhone,
          status: "active",
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.embedded_signup",
          entityType: "channel_connection",
          entityId: channel.id,
          after: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId },
        },
      });
      return { ok: true, id: channel.id, name, displayPhone, businessName };
    });
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const input = parse(updateChannelSchema, body);

    // Estado actual para saber el token/WABA/número EFECTIVOS con los que
    // re-enganchar en Meta si cambian datos de WhatsApp (subscribe+register NO
    // puede ir dentro de withTenant, que es una tx interactiva).
    const current = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const channel = await tx.channelConnection.findUnique({ where: { id } });
      if (!channel) throw new NotFoundException("Canal no encontrado");
      const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: id } });
      const account = number ? await tx.whatsappAccount.findUnique({ where: { id: number.accountId } }) : null;
      const credential = account?.credentialId
        ? await tx.integrationCredential.findUnique({ where: { id: account.credentialId } })
        : null;
      return {
        type: channel.type,
        numberId: number?.id ?? null,
        accountId: account?.id ?? null,
        wabaId: account?.wabaId ?? null,
        phoneNumberId: number?.phoneNumberId ?? null,
        token: credential ? decryptSecret(credential.ciphertext) : null,
      };
    });

    // Re-enganche en Meta si es WhatsApp y se repega el token o cambia WABA/número.
    // Un token fresco RE-REGISTRA el número (justo el caso del token de prueba que
    // caduca cada 24h): así al editar el canal vuelve a poder ENVIAR sin usar Graph.
    let warnings: string[] = [];
    if (current.type === "WHATSAPP_CLOUD") {
      const effToken = input.accessToken ?? current.token;
      const effWaba = input.wabaId ?? current.wabaId;
      const effPhone = input.phoneNumberId ?? current.phoneNumberId;
      const changedWhatsapp = !!(input.accessToken || input.wabaId || input.phoneNumberId);
      if (changedWhatsapp && effToken && effWaba && effPhone) {
        warnings = await subscribeAndRegisterWhatsapp(effWaba, effPhone, effToken);
      }
    }

    const updated = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const channel = await tx.channelConnection.findUnique({ where: { id } });
      if (!channel) throw new NotFoundException("Canal no encontrado");

      // Repegar token → nueva credencial cifrada sobre la WABA del canal.
      if (input.accessToken && current.accountId) {
        const credential = await tx.integrationCredential.create({
          data: {
            organizationId: ctx.organizationId,
            provider: "whatsapp",
            label: `Token ${input.name ?? channel.name} (editado)`,
            ciphertext: encryptSecret(input.accessToken),
          },
        });
        await tx.whatsappAccount.update({ where: { id: current.accountId }, data: { credentialId: credential.id } });
      }

      // WABA ID (sobre la cuenta).
      if (input.wabaId && current.accountId && input.wabaId !== current.wabaId) {
        await tx.whatsappAccount.update({ where: { id: current.accountId }, data: { wabaId: input.wabaId } });
      }

      // Número visible y/o phone_number_id (sobre el número del canal).
      const changingPhone = !!(input.phoneNumberId && input.phoneNumberId !== current.phoneNumberId);
      if (current.numberId && (input.displayPhone !== undefined || changingPhone)) {
        if (changingPhone) {
          const clash = await tx.whatsappPhoneNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId! } });
          if (clash) throw new BadRequestException("Ese phone_number_id ya está conectado en otro canal");
        }
        await tx.whatsappPhoneNumber.update({
          where: { id: current.numberId },
          data: {
            ...(changingPhone ? { phoneNumberId: input.phoneNumberId! } : {}),
            ...(input.displayPhone !== undefined
              ? { displayPhone: input.displayPhone || input.phoneNumberId || current.phoneNumberId || "" }
              : {}),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.update",
          entityType: "channel_connection",
          entityId: id,
          after: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.wabaId ? { wabaId: input.wabaId } : {}),
            ...(input.phoneNumberId ? { phoneNumberId: input.phoneNumberId } : {}),
            tokenRotated: !!input.accessToken,
          },
        },
      });

      return tx.channelConnection.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
          // Repegar token limpia el estado de error (se re-evalúa al probar).
          ...(input.status ? { status: input.status } : input.accessToken ? { status: "active" } : {}),
        },
      });
    });

    return { ...updated, warnings };
  }

  /** Prueba la conexión: para WhatsApp consulta el número en la Graph API de Meta. */
  @Post(":id/test")
  async test(@Param("id") id: string) {
    const ctx = requirePermission("channels:write");
    const env = getEnv();
    const data = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const channel = await tx.channelConnection.findUnique({ where: { id } });
      if (!channel) throw new NotFoundException("Canal no encontrado");
      if (channel.type === "MOCK") return { mock: true as const };
      const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: id } });
      if (!number) throw new BadRequestException("El canal no tiene número asociado");
      const account = await tx.whatsappAccount.findUnique({ where: { id: number.accountId } });
      const credential = account?.credentialId
        ? await tx.integrationCredential.findUnique({ where: { id: account.credentialId } })
        : null;
      return {
        mock: false as const,
        phoneNumberId: number.phoneNumberId,
        token: credential ? decryptSecret(credential.ciphertext) : env.META_ACCESS_TOKEN,
      };
    });

    if (data.mock) return { ok: true, detail: "Canal mock operativo (no requiere Meta)" };
    if (!data.token) return { ok: false, detail: "Sin token: carga el access token del canal" };

    try {
      // graphFetch reintenta con el token global si el del canal está vencido.
      const { res, json, usedFallback } = await this.graphFetch(
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${data.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
        data.token,
      );
      if (!res.ok) {
        if (json?.error?.code === 190 || res.status === 401) {
          await this.setChannelHealth(ctx.organizationId, id, "error", `Prueba de conexión: ${json?.error?.message ?? res.status}`);
        }
        return { ok: false, detail: json?.error?.message ?? `Meta respondió ${res.status}` };
      }
      const detail = `Número verificado: ${json.display_phone_number ?? "?"} (${json.verified_name ?? "sin nombre"}) · calidad: ${json.quality_rating ?? "?"}`;
      if (usedFallback) {
        // El token PROPIO del canal está vencido (funcionó solo el global):
        // marcar para que el equipo reautorice antes de que fallen los envíos.
        await this.setChannelHealth(ctx.organizationId, id, "error", "El token del canal está vencido (la prueba funcionó con el token global). Reautoriza WhatsApp.");
        return { ok: true, detail: `${detail} · ⚠ token del canal vencido — reautoriza WhatsApp` };
      }
      await this.setChannelHealth(ctx.organizationId, id, "active");
      return { ok: true, detail };
    } catch (err) {
      return { ok: false, detail: `Error de red: ${(err as Error).message}` };
    }
  }

  /** Salud del canal: últimos eventos de WhatsApp (auth, calidad, plantillas, cuenta). */
  @Get("health/events")
  healthEvents() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const events = await tx.integrationEvent.findMany({
        where: { provider: "whatsapp" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, type: true, status: true, message: true, createdAt: true },
      });
      return { events };
    });
  }

  // ------------------- Plantillas de mensaje (WABA) -------------------

  /** WABA + token del canal (token por-canal cifrado; fallback al global). */
  private async resolveWaba(
    organizationId: string,
    channelId: string,
  ): Promise<{ wabaId: string; token: string; accountId: string; mappings: Record<string, { fields?: string[] }> }> {
    const env = getEnv();
    const data = await this.prisma.withTenant(organizationId, async (tx) => {
      const channel = await tx.channelConnection.findUnique({ where: { id: channelId } });
      if (!channel) throw new NotFoundException("Canal no encontrado");
      if (channel.type !== "WHATSAPP_CLOUD") {
        throw new BadRequestException("Las plantillas solo aplican a canales de WhatsApp Cloud");
      }
      const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: channelId } });
      const account = number ? await tx.whatsappAccount.findUnique({ where: { id: number.accountId } }) : null;
      if (!account?.wabaId) throw new BadRequestException("El canal no tiene una WABA asociada");
      const credential = account.credentialId
        ? await tx.integrationCredential.findUnique({ where: { id: account.credentialId } })
        : null;
      return {
        wabaId: account.wabaId,
        accountId: account.id,
        token: credential ? decryptSecret(credential.ciphertext) : env.META_ACCESS_TOKEN,
        mappings: (((channel.config as any)?.templateMappings ?? {}) as Record<string, { fields?: string[] }>),
      };
    });
    if (!data.token) throw new BadRequestException("Sin token de acceso: carga el access token del canal");
    return { wabaId: data.wabaId, token: data.token, accountId: data.accountId, mappings: data.mappings };
  }

  /** Proyecta la lista de plantillas de Graph hacia whatsapp_templates (sync). */
  private async persistTemplates(
    organizationId: string,
    accountId: string,
    templates: any[],
    mappings: Record<string, { fields?: string[] }>,
  ): Promise<number> {
    let synced = 0;
    await this.prisma.withTenant(organizationId, async (tx) => {
      const seen = new Set<string>();
      for (const t of templates) {
        const language = String(t.language ?? "es");
        seen.add(`${t.name}::${language}`);
        const body = {
          components: t.components ?? [],
          rejectedReason: t.rejected_reason ?? null,
          variableFields: mappings[t.name]?.fields ?? null,
          syncedAt: new Date().toISOString(),
        } as object;
        await tx.whatsappTemplate.upsert({
          where: {
            organizationId_accountId_name_language: { organizationId, accountId, name: String(t.name), language },
          },
          update: { status: String(t.status ?? "PENDING"), category: String(t.category ?? "UTILITY"), body },
          create: {
            organizationId,
            accountId,
            name: String(t.name),
            language,
            category: String(t.category ?? "UTILITY"),
            status: String(t.status ?? "PENDING"),
            body,
          },
        });
        synced++;
      }
      const existing = await tx.whatsappTemplate.findMany({ where: { accountId }, select: { id: true, name: true, language: true } });
      const stale = existing.filter((e) => !seen.has(`${e.name}::${e.language}`));
      if (stale.length) await tx.whatsappTemplate.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    });
    return synced;
  }

  /**
   * Llama a la Graph API con el token del canal; si Meta responde token
   * inválido/vencido (código 190) reintenta con el token global de la
   * plataforma. Cubre canales creados con tokens temporales que expiraron
   * (el permanente vive en el env y es el que usa el worker para enviar).
   */
  private async graphFetch(url: string, token: string, init?: RequestInit): Promise<{ res: Response; json: any; usedFallback: boolean }> {
    const doFetch = async (tk: string) => {
      // appsecret_proof va firmado con el token efectivo de cada intento.
      const res = await fetch(withAppSecretProof(url, tk), {
        ...init,
        headers: { ...((init?.headers as Record<string, string>) ?? {}), authorization: `Bearer ${tk}` },
      });
      const json: any = await res.json().catch(() => ({}));
      return { res, json };
    };
    let out = await doFetch(token);
    let usedFallback = false;
    const globalToken = getEnv().META_ACCESS_TOKEN;
    if (!out.res.ok && out.json?.error?.code === 190 && globalToken && globalToken !== token) {
      out = await doFetch(globalToken);
      usedFallback = true;
    }
    return { ...out, usedFallback };
  }

  /** Actualiza el estado del canal + registra el evento en la actividad (best-effort). */
  private async setChannelHealth(organizationId: string, channelId: string, status: "active" | "error", message?: string) {
    try {
      await this.prisma.withTenant(organizationId, async (tx) => {
        const channel = await tx.channelConnection.findUnique({ where: { id: channelId }, select: { status: true } });
        // No revivir canales desactivados a mano ni repetir el mismo estado.
        if (!channel || channel.status === "inactive" || channel.status === status) return;
        await tx.channelConnection.update({ where: { id: channelId }, data: { status } });
        await tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "whatsapp",
            type: status === "error" ? "channel.auth_error" : "channel.recovered",
            status: status === "error" ? "error" : "ok",
            message: message ?? (status === "error" ? "Token del canal inválido — reautoriza WhatsApp" : "Canal reautorizado correctamente"),
          },
        });
      });
    } catch {
      /* best-effort */
    }
  }

  /** Plantillas APROBADAS del tenant (proyección local) — para bandeja y workflows. */
  @Get("templates/approved")
  approvedTemplates() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const rows = await tx.whatsappTemplate.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" } });
      return {
        templates: rows.map((t) => {
          const body = (t.body as Record<string, any>) ?? {};
          const components = Array.isArray(body.components) ? body.components : [];
          return {
            id: t.id,
            name: t.name,
            language: t.language,
            category: t.category,
            bodyText: components.find((c: any) => c?.type === "BODY")?.text ?? "",
            variableFields: Array.isArray(body.variableFields) ? body.variableFields : [],
          };
        }),
      };
    });
  }

  /** Sincroniza AHORA las plantillas del canal desde Graph hacia la proyección local. */
  @Post(":id/templates/sync")
  async syncTemplates(@Param("id") id: string) {
    const ctx = requirePermission("channels:write");
    const env = getEnv();
    const { wabaId, token, accountId, mappings } = await this.resolveWaba(ctx.organizationId, id);
    const { res, json } = await this.graphFetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=200`,
      token,
    );
    if (!res.ok) throw new BadRequestException(json?.error?.message ?? `Meta respondió ${res.status}`);
    const synced = await this.persistTemplates(ctx.organizationId, accountId, (json?.data as any[]) ?? [], mappings);
    return { ok: true, synced };
  }

  /** Lista las plantillas de la WABA del canal (estado, categoría, idioma, contenido). */
  /**
   * Estado del interruptor de mensajes de plantilla para el tenant (panel de
   * Plantillas). Incluye el precio de activación (platform_setting) para el CTA
   * de contratación cuando la función no está incluida.
   */
  @Get("templates/entitlement")
  async templatesEntitlement() {
    const ctx = requireContext();
    const ent = await this.prisma.withTenant(ctx.organizationId, (tx) => getTemplatesEntitlement(tx));
    const priceRow = await this.prisma.admin.platformSetting.findUnique({ where: { key: "templatesActivation" } });
    let activation: { priceClp: number | null; priceUsd: number | null } = { priceClp: null, priceUsd: null };
    if (priceRow?.value) {
      try {
        const p = JSON.parse(priceRow.value);
        activation = { priceClp: typeof p.priceClp === "number" ? p.priceClp : null, priceUsd: typeof p.priceUsd === "number" ? p.priceUsd : null };
      } catch {
        /* valor corrupto → sin precio */
      }
    }
    return { ...ent, activation };
  }

  @Get(":id/templates")
  async listTemplates(@Param("id") id: string) {
    const ctx = requireContext();
    const env = getEnv();
    const { wabaId, token, accountId, mappings } = await this.resolveWaba(ctx.organizationId, id);
    const { res, json } = await this.graphFetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`,
      token,
    );
    if (!res.ok) throw new BadRequestException(json?.error?.message ?? `Meta respondió ${res.status}`);
    // Cada vista del panel refresca también la proyección local (sync implícita).
    await this.persistTemplates(ctx.organizationId, accountId, (json?.data as any[]) ?? [], mappings).catch(() => 0);
    return {
      wabaId,
      templates: ((json?.data as any[]) ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language,
        rejectedReason: t.rejected_reason ?? null,
        components: t.components ?? [],
        variableFields: mappings[t.name]?.fields ?? null,
      })),
    };
  }

  /** Crea una plantilla en la WABA del canal (queda PENDING hasta que Meta la apruebe). */
  @Post(":id/templates")
  async createTemplate(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const env = getEnv();
    const input = parse(createTemplateSchema, body);
    const varCount = bodyVariableCount(input.bodyText);
    if (varCount > 0 && (input.bodyExamples?.length ?? 0) < varCount) {
      throw new BadRequestException(`El cuerpo usa ${varCount} variable(s): entrega un valor de ejemplo por cada una`);
    }
    if (input.variableFields && input.variableFields.length !== varCount) {
      throw new BadRequestException(`El mapeo de campos (${input.variableFields.length}) no coincide con las variables del cuerpo (${varCount})`);
    }
    const { wabaId, token } = await this.resolveWaba(ctx.organizationId, id);

    const components: Record<string, unknown>[] = [];
    if (input.headerText) components.push({ type: "HEADER", format: "TEXT", text: input.headerText });
    components.push({
      type: "BODY",
      text: input.bodyText,
      ...(varCount > 0 ? { example: { body_text: [input.bodyExamples!.slice(0, varCount)] } } : {}),
    });
    if (input.footerText) components.push({ type: "FOOTER", text: input.footerText });
    if (input.quickReplies?.length) {
      components.push({ type: "BUTTONS", buttons: input.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })) });
    }

    const { res, json } = await this.graphFetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: input.name, category: input.category, language: input.language, components }),
      },
    );
    if (!res.ok) {
      throw new BadRequestException(json?.error?.error_user_msg ?? json?.error?.message ?? `Meta respondió ${res.status}`);
    }
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // Persistir el mapeo variable→campo en el config del canal (para el envío).
      if (input.variableFields?.length) {
        const channel = await tx.channelConnection.findUnique({ where: { id }, select: { config: true } });
        const config = ((channel?.config as object) ?? {}) as Record<string, unknown>;
        const templateMappings = ((config.templateMappings as object) ?? {}) as Record<string, unknown>;
        templateMappings[input.name] = { language: input.language, fields: input.variableFields };
        await tx.channelConnection.update({ where: { id }, data: { config: { ...config, templateMappings } as object } });
      }
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.template_create",
          entityType: "channel_connection",
          entityId: id,
          after: { wabaId, name: input.name, category: input.category, language: input.language, fields: input.variableFields ?? [] },
        },
      });
    });
    return { ok: true, id: json?.id ?? null, status: json?.status ?? "PENDING", category: json?.category ?? input.category };
  }

  /** Elimina una plantilla por nombre (todas sus variantes de idioma). */
  @Delete(":id/templates/:name")
  async deleteTemplate(@Param("id") id: string, @Param("name") name: string) {
    const ctx = requirePermission("channels:write");
    const env = getEnv();
    if (!/^[a-z0-9_]+$/.test(name)) throw new BadRequestException("Nombre de plantilla inválido");
    const { wabaId, token } = await this.resolveWaba(ctx.organizationId, id);
    const { res, json } = await this.graphFetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}`,
      token,
      { method: "DELETE" },
    );
    if (!res.ok) throw new BadRequestException(json?.error?.message ?? `Meta respondió ${res.status}`);
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // Retirar el mapeo variable→campo de la plantilla eliminada.
      const channel = await tx.channelConnection.findUnique({ where: { id }, select: { config: true } });
      const config = ((channel?.config as object) ?? {}) as Record<string, unknown>;
      const templateMappings = ((config.templateMappings as object) ?? {}) as Record<string, unknown>;
      if (templateMappings[name]) {
        delete templateMappings[name];
        await tx.channelConnection.update({ where: { id }, data: { config: { ...config, templateMappings } as object } });
      }
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.template_delete",
          entityType: "channel_connection",
          entityId: id,
          after: { wabaId, name },
        },
      });
    });
    return { ok: true };
  }

  /**
   * Elimina un canal por completo: borra sus números de WhatsApp, la WABA y su
   * credencial cifrada SI no le quedan números (no toca una WABA compartida), y
   * el propio canal. Las conversaciones históricas se conservan (la referencia al
   * canal es laxa). Así el sync de plantillas deja de tocar un número/token muerto.
   */
  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("channels:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const channel = await tx.channelConnection.findFirst({ where: { id } });
      if (!channel) throw new NotFoundException("Canal no encontrado");
      const phones = await tx.whatsappPhoneNumber.findMany({ where: { channelConnectionId: id }, select: { accountId: true } });
      const accountIds = [...new Set(phones.map((p) => p.accountId))];
      if (phones.length) await tx.whatsappPhoneNumber.deleteMany({ where: { channelConnectionId: id } });
      // Borra la WABA + credencial solo si ya no le quedan números (evita romper
      // otro canal que comparta la misma WABA).
      for (const accId of accountIds) {
        const remaining = await tx.whatsappPhoneNumber.count({ where: { accountId: accId } });
        if (remaining === 0) {
          const acc = await tx.whatsappAccount.findUnique({ where: { id: accId }, select: { credentialId: true } });
          await tx.whatsappAccount.delete({ where: { id: accId } });
          if (acc?.credentialId) await tx.integrationCredential.deleteMany({ where: { id: acc.credentialId } });
        }
      }
      await tx.channelConnection.delete({ where: { id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "channel.delete", entityType: "channel_connection", entityId: id, after: { name: channel.name } },
      });
      return { ok: true };
    });
  }
}
