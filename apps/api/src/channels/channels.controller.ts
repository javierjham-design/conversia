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
import { getEnv } from "@conversia/config";
import { TEMPLATE_FIELD_IDS } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret, maskSecret } from "../common/crypto";
import { enforcePlanLimit } from "../common/plan-limits";
import { requirePermission } from "../tenancy/permissions";
import { requireContext } from "../tenancy/context";

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
      const [channels, numbers, agents] = await Promise.all([
        tx.channelConnection.findMany({ orderBy: { createdAt: "asc" } }),
        tx.whatsappPhoneNumber.findMany(),
        tx.agent.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
      ]);
      const agentName = new Map(agents.map((a) => [a.id, a.name]));
      return channels.map((c) => {
        const number = numbers.find((n) => n.channelConnectionId === c.id);
        return {
          id: c.id,
          type: c.type,
          name: c.name,
          status: c.status,
          defaultAgentId: c.defaultAgentId,
          defaultAgentName: c.defaultAgentId ? (agentName.get(c.defaultAgentId) ?? null) : null,
          phoneNumberId: number?.phoneNumberId ?? null,
          displayPhone: number?.displayPhone ?? null,
          createdAt: c.createdAt,
        };
      });
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const input = parse(createChannelSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await enforcePlanLimit(
        tx,
        "channels",
        await tx.channelConnection.count({ where: { status: { not: "inactive" } } }),
      );
      if (input.type === "WHATSAPP_CLOUD") {
        if (!input.phoneNumberId || !input.wabaId || !input.accessToken) {
          throw new BadRequestException("WhatsApp Cloud requiere phoneNumberId, wabaId y accessToken");
        }
        const existing = await tx.whatsappPhoneNumber.findUnique({
          where: { phoneNumberId: input.phoneNumberId },
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
    await fetch(`https://graph.facebook.com/${v}/${encodeURIComponent(input.wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);

    // 3. Registrar el número para Cloud API — best-effort (puede estar ya registrado)
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    await fetch(`https://graph.facebook.com/${v}/${encodeURIComponent(input.phoneNumberId)}/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    }).catch(() => undefined);

    // 4. Nombre visible del número — best-effort
    let displayPhone = input.phoneNumberId;
    try {
      const numRes = await fetch(
        `https://graph.facebook.com/${v}/${encodeURIComponent(input.phoneNumberId)}?fields=display_phone_number,verified_name`,
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
          `https://graph.facebook.com/${v}/${encodeURIComponent(input.businessId)}?fields=name`,
          { headers: { authorization: `Bearer ${accessToken}` } },
        );
        const bJson: any = await bRes.json();
        if (bRes.ok && bJson?.name) businessName = bJson.name;
      } catch {
        /* ignore */
      }
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
          await tx.channelConnection.update({
            where: { id: existing.channelConnectionId },
            data: {
              status: "active",
              ...(input.defaultAgentId ? { defaultAgentId: input.defaultAgentId } : {}),
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
  update(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("channels:write");
    const input = parse(updateChannelSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const channel = await tx.channelConnection.findUnique({ where: { id } });
      if (!channel) throw new NotFoundException("Canal no encontrado");

      if (input.accessToken) {
        const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: id } });
        const account = number ? await tx.whatsappAccount.findUnique({ where: { id: number.accountId } }) : null;
        if (account) {
          const credential = await tx.integrationCredential.create({
            data: {
              organizationId: ctx.organizationId,
              provider: "whatsapp",
              label: `Token ${channel.name} (rotado)`,
              ciphertext: encryptSecret(input.accessToken),
            },
          });
          await tx.whatsappAccount.update({ where: { id: account.id }, data: { credentialId: credential.id } });
        }
      }

      return tx.channelConnection.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
    });
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
      const res = await fetch(
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${data.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { authorization: `Bearer ${data.token}` } },
      );
      const json: any = await res.json();
      if (!res.ok) {
        return { ok: false, detail: json?.error?.message ?? `Meta respondió ${res.status}` };
      }
      return {
        ok: true,
        detail: `Número verificado: ${json.display_phone_number ?? "?"} (${json.verified_name ?? "sin nombre"}) · calidad: ${json.quality_rating ?? "?"}`,
      };
    } catch (err) {
      return { ok: false, detail: `Error de red: ${(err as Error).message}` };
    }
  }

  // ------------------- Plantillas de mensaje (WABA) -------------------

  /** WABA + token del canal (token por-canal cifrado; fallback al global). */
  private async resolveWaba(organizationId: string, channelId: string): Promise<{ wabaId: string; token: string }> {
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
      return { wabaId: account.wabaId, token: credential ? decryptSecret(credential.ciphertext) : env.META_ACCESS_TOKEN };
    });
    if (!data.token) throw new BadRequestException("Sin token de acceso: carga el access token del canal");
    return { wabaId: data.wabaId, token: data.token };
  }

  /** Lista las plantillas de la WABA del canal (estado, categoría, idioma, contenido). */
  @Get(":id/templates")
  async listTemplates(@Param("id") id: string) {
    const ctx = requireContext();
    const env = getEnv();
    const { wabaId, token } = await this.resolveWaba(ctx.organizationId, id);
    const res = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(json?.error?.message ?? `Meta respondió ${res.status}`);
    // Mapeo variable→campo guardado al crear cada plantilla desde el panel.
    const mappings = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const channel = await tx.channelConnection.findUnique({ where: { id }, select: { config: true } });
      return ((channel?.config as any)?.templateMappings ?? {}) as Record<string, { fields?: string[] }>;
    });
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

    const res = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: input.name, category: input.category, language: input.language, components }),
      },
    );
    const json: any = await res.json().catch(() => ({}));
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
    const res = await fetch(
      `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
    );
    const json: any = await res.json().catch(() => ({}));
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

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("channels:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.channelConnection.update({ where: { id }, data: { status: "inactive" } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.deactivate",
          entityType: "channel_connection",
          entityId: id,
        },
      });
      return { ok: true };
    });
  }
}
