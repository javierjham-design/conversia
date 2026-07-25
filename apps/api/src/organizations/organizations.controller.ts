import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
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
