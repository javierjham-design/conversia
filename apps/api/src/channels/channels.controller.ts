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
