import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const stageSchema = z.object({
  name: z.string().min(2).max(50),
  emoji: z.string().max(8).optional().nullable(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .nullable(),
  category: z.enum(["OPEN", "WON", "LOST", "FROZEN"]).optional(),
});

/** code estable a partir del nombre (los workflows referencian el code). */
export function slugifyStageCode(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * Etapas del ciclo de vida EDITABLES por tenant (estilo Respond.io): cada
 * cliente puede renombrar las estándar, cambiar emoji/color/categoría,
 * reordenar y crear las suyas. El `code` es estable (lo usan los workflows,
 * las reglas CAPI y las bandejas guardadas); solo se fija al crear.
 */
@Controller("lifecycle-stages")
export class LifecycleController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [stages, usage] = await Promise.all([
        tx.leadStatus.findMany({ orderBy: { order: "asc" } }),
        tx.lead.groupBy({ by: ["statusId"], _count: { _all: true } }),
      ]);
      const countByStatus = new Map(usage.map((u) => [u.statusId, u._count._all]));
      return stages.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        emoji: s.emoji,
        color: s.color,
        category: s.category,
        order: s.order,
        system: s.system,
        leadsCount: countByStatus.get(s.id) ?? 0,
      }));
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("leads:write");
    const parsed = stageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Etapa inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      let code = slugifyStageCode(parsed.data.name);
      if (!code) throw new BadRequestException("El nombre debe tener letras o números");
      // Unicidad del code: sufijo incremental si choca
      for (let i = 2; await tx.leadStatus.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } } }); i++) {
        code = `${slugifyStageCode(parsed.data.name)}_${i}`;
      }
      const max = await tx.leadStatus.aggregate({ _max: { order: true } });
      const stage = await tx.leadStatus.create({
        data: {
          organizationId: ctx.organizationId,
          code,
          name: parsed.data.name.trim(),
          emoji: parsed.data.emoji ?? null,
          color: parsed.data.color ?? null,
          category: (parsed.data.category ?? "OPEN") as any,
          order: (max._max.order ?? 0) + 1,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lifecycle.stage_create", entityType: "lead_status", entityId: stage.id, after: { code, name: stage.name } },
      });
      return stage;
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("leads:write");
    const parsed = stageSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException("Etapa inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const stage = await tx.leadStatus.findUnique({ where: { id } });
      if (!stage) throw new NotFoundException("Etapa no encontrada");
      const updated = await tx.leadStatus.update({
        where: { id },
        data: {
          ...(parsed.data.name ? { name: parsed.data.name.trim() } : {}),
          ...(parsed.data.emoji !== undefined ? { emoji: parsed.data.emoji || null } : {}),
          ...(parsed.data.color !== undefined ? { color: parsed.data.color || null } : {}),
          ...(parsed.data.category ? { category: parsed.data.category as any } : {}),
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lifecycle.stage_update", entityType: "lead_status", entityId: id, after: parsed.data as object },
      });
      return updated;
    });
  }

  /** Reordena las etapas (lista completa de ids en el orden final). */
  @Post("reorder")
  reorder(@Body() body: unknown) {
    const ctx = requirePermission("leads:write");
    const parsed = z.object({ ids: z.array(z.string()).min(1).max(50) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("ids requeridos");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      for (let i = 0; i < parsed.data.ids.length; i++) {
        await tx.leadStatus.updateMany({ where: { id: parsed.data.ids[i] }, data: { order: i } });
      }
      return { ok: true };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("leads:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const stage = await tx.leadStatus.findUnique({ where: { id } });
      if (!stage) throw new NotFoundException("Etapa no encontrada");
      const inUse = await tx.lead.count({ where: { statusId: id } });
      if (inUse > 0) {
        throw new BadRequestException(
          `No se puede eliminar «${stage.name}»: ${inUse} lead(s) están en esta etapa. Muévelos a otra etapa primero (o renómbrala).`,
        );
      }
      await tx.leadStatus.delete({ where: { id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lifecycle.stage_delete", entityType: "lead_status", entityId: id, after: { code: stage.code, name: stage.name } },
      });
      return { ok: true };
    });
  }
}
