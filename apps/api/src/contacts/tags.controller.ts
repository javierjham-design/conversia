import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const tagSchema = z.object({
  name: z.string().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .nullable(),
});

/** Etiquetas del tenant (/settings/tags): CRUD, conteo de uso, fusión y borrado. */
@Controller("tags")
export class TagsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [tags, usage] = await Promise.all([
        tx.tag.findMany({ orderBy: { name: "asc" } }),
        tx.tagAssignment.groupBy({ by: ["tagId"], _count: { _all: true } }),
      ]);
      const countByTag = new Map(usage.map((u) => [u.tagId, u._count._all]));
      return tags.map((t) => ({ id: t.id, name: t.name, color: t.color, usage: countByTag.get(t.id) ?? 0 }));
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const parsed = tagSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Etiqueta inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.tag.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: parsed.data.name.trim() } },
      });
      if (exists) throw new BadRequestException("Ya existe una etiqueta con ese nombre");
      return tx.tag.create({
        data: { organizationId: ctx.organizationId, name: parsed.data.name.trim(), color: parsed.data.color ?? null },
      });
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const parsed = tagSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException("Etiqueta inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const tag = await tx.tag.findUnique({ where: { id } });
      if (!tag) throw new NotFoundException("Etiqueta no encontrada");
      if (parsed.data.name && parsed.data.name.trim() !== tag.name) {
        const clash = await tx.tag.findUnique({
          where: { organizationId_name: { organizationId: ctx.organizationId, name: parsed.data.name.trim() } },
        });
        if (clash) throw new BadRequestException("Ya existe una etiqueta con ese nombre — usa Fusionar");
      }
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.tag_update", entityType: "tag", entityId: id, before: { name: tag.name }, after: parsed.data as object },
      });
      return tx.tag.update({
        where: { id },
        data: {
          ...(parsed.data.name ? { name: parsed.data.name.trim() } : {}),
          ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        },
      });
    });
  }

  /** Fusiona la etiqueta origen dentro de la destino (reasigna usos y borra la origen). */
  @Post("merge")
  merge(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const parsed = z.object({ sourceId: z.string().min(1), targetId: z.string().min(1) }).safeParse(body);
    if (!parsed.success || parsed.data.sourceId === parsed.data.targetId) {
      throw new BadRequestException("Elige dos etiquetas distintas");
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [source, target] = await Promise.all([
        tx.tag.findUnique({ where: { id: parsed.data.sourceId } }),
        tx.tag.findUnique({ where: { id: parsed.data.targetId } }),
      ]);
      if (!source || !target) throw new NotFoundException("Etiqueta no encontrada");
      // Usos que ya existen en la destino → se eliminan de la origen (evita duplicar)
      const targetKeys = await tx.tagAssignment.findMany({
        where: { tagId: target.id },
        select: { entityType: true, entityId: true },
      });
      const dupSet = new Set(targetKeys.map((k) => `${k.entityType}:${k.entityId}`));
      const sourceAsg = await tx.tagAssignment.findMany({ where: { tagId: source.id } });
      let moved = 0;
      for (const a of sourceAsg) {
        if (dupSet.has(`${a.entityType}:${a.entityId}`)) {
          await tx.tagAssignment.delete({ where: { id: a.id } });
        } else {
          await tx.tagAssignment.update({ where: { id: a.id }, data: { tagId: target.id } });
          moved++;
        }
      }
      await tx.tag.delete({ where: { id: source.id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.tag_merge", entityType: "tag", entityId: target.id, after: { from: source.name, to: target.name, moved } },
      });
      return { ok: true, moved };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("contacts:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const tag = await tx.tag.findUnique({ where: { id } });
      if (!tag) throw new NotFoundException("Etiqueta no encontrada");
      const usage = await tx.tagAssignment.count({ where: { tagId: id } });
      await tx.tagAssignment.deleteMany({ where: { tagId: id } });
      await tx.tag.delete({ where: { id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.tag_delete", entityType: "tag", entityId: id, after: { name: tag.name, usage } },
      });
      return { ok: true, removedUsage: usage };
    });
  }
}
