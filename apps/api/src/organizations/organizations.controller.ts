import { BadRequestException, Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";

const createClinicSchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  address: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().default("America/Santiago"),
});

@Controller("organizations")
export class OrganizationsController {
  constructor(private prisma: PrismaService) {}

  @Get("me")
  overview() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [org, clinics, agents, workflows, conversations] = await Promise.all([
        tx.organization.findUnique({ where: { id: ctx.organizationId } }),
        tx.clinic.findMany({ where: { deletedAt: null } }),
        tx.agent.count({ where: { deletedAt: null } }),
        tx.workflow.count({ where: { deletedAt: null } }),
        tx.conversation.count(),
      ]);
      return { organization: org, clinics, counts: { agents, workflows, conversations } };
    });
  }

  @Post("me/clinics")
  createClinic(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = createClinicSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.clinic.create({ data: { ...parsed.data, organizationId: ctx.organizationId } }),
    );
  }

  @Get("me/agents")
  agents() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.agent.findMany({
        where: { deletedAt: null },
        include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
        orderBy: { createdAt: "asc" },
      }),
    );
  }

  @Get("me/workflows")
  workflows() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.workflow.findMany({
        where: { deletedAt: null },
        include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
      }),
    );
  }

  /** Canales del tenant con su agente por defecto. */
  @Get("me/channels")
  channels() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.channelConnection.findMany({ orderBy: { createdAt: "asc" } }),
    );
  }

  /** Define qué agente atiende por defecto las conversaciones nuevas del canal. */
  @Put("me/channels/:id/default-agent")
  async setChannelDefaultAgent(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ agentId: z.string().nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("agentId requerido (o null)");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      if (parsed.data.agentId) {
        const agent = await tx.agent.findFirst({ where: { id: parsed.data.agentId, deletedAt: null } });
        if (!agent) throw new BadRequestException("Agente no encontrado");
      }
      const channel = await tx.channelConnection.update({
        where: { id },
        data: { defaultAgentId: parsed.data.agentId },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "channel.set_default_agent",
          entityType: "channel_connection",
          entityId: id,
          after: { agentId: parsed.data.agentId },
        },
      });
      return channel;
    });
  }

  @Get("me/usage")
  async usage() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const events = await tx.usageEvent.groupBy({
        by: ["type"],
        where: { occurredAt: { gte: since } },
        _sum: { quantity: true, costUsd: true },
      });
      return { since: since.toISOString(), byType: events };
    });
  }
}
