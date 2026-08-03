import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { slugifyStageCode } from "./lifecycle.controller";

const fieldSchema = z.object({
  label: z.string().min(2).max(60),
  type: z.enum(["text", "number", "date", "select", "boolean"]).optional(),
  options: z.array(z.string().min(1).max(60)).max(30).optional(),
  required: z.boolean().optional(),
  showInList: z.boolean().optional(),
});

/**
 * Campos personalizados de contacto del tenant (/settings/contact-fields).
 * La ficha del contacto (drawer de Contactos) los muestra en el orden aquí
 * definido; showInList marca cuáles se ofrecen como columnas en Contactos.
 */
@Controller("contact-fields")
export class ContactFieldsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [defs, usage] = await Promise.all([
        tx.customFieldDefinition.findMany({ where: { entity: "contact" }, orderBy: [{ order: "asc" }, { createdAt: "asc" }] }),
        tx.customFieldValue.groupBy({ by: ["definitionId"], _count: { _all: true } }),
      ]);
      const countByDef = new Map(usage.map((u) => [u.definitionId, u._count._all]));
      return defs.map((d) => ({
        id: d.id,
        key: d.key,
        label: d.label,
        type: d.type,
        options: d.options,
        required: d.required,
        order: d.order,
        showInList: d.showInList,
        valuesCount: countByDef.get(d.id) ?? 0,
      }));
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const parsed = fieldSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Campo inválido");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      let key = slugifyStageCode(parsed.data.label);
      if (!key) throw new BadRequestException("El nombre debe tener letras o números");
      for (let i = 2; await tx.customFieldDefinition.findUnique({ where: { organizationId_entity_key: { organizationId: ctx.organizationId, entity: "contact", key } } }); i++) {
        key = `${slugifyStageCode(parsed.data.label)}_${i}`;
      }
      const max = await tx.customFieldDefinition.aggregate({ where: { entity: "contact" }, _max: { order: true } });
      const field = await tx.customFieldDefinition.create({
        data: {
          organizationId: ctx.organizationId,
          entity: "contact",
          key,
          label: parsed.data.label.trim(),
          type: parsed.data.type ?? "text",
          options: (parsed.data.options ?? []) as object,
          required: parsed.data.required ?? false,
          showInList: parsed.data.showInList ?? false,
          order: (max._max.order ?? 0) + 1,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.contact_field_create", entityType: "custom_field", entityId: field.id, after: { key, label: field.label } },
      });
      return field;
    });
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const parsed = fieldSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException("Campo inválido");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const field = await tx.customFieldDefinition.findUnique({ where: { id } });
      if (!field || field.entity !== "contact") throw new NotFoundException("Campo no encontrado");
      const updated = await tx.customFieldDefinition.update({
        where: { id },
        data: {
          ...(parsed.data.label ? { label: parsed.data.label.trim() } : {}),
          ...(parsed.data.type ? { type: parsed.data.type } : {}),
          ...(parsed.data.options ? { options: parsed.data.options as object } : {}),
          ...(parsed.data.required !== undefined ? { required: parsed.data.required } : {}),
          ...(parsed.data.showInList !== undefined ? { showInList: parsed.data.showInList } : {}),
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.contact_field_update", entityType: "custom_field", entityId: id, after: parsed.data as object },
      });
      return updated;
    });
  }

  @Post("reorder")
  reorder(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const parsed = z.object({ ids: z.array(z.string()).min(1).max(60) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("ids requeridos");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      for (let i = 0; i < parsed.data.ids.length; i++) {
        await tx.customFieldDefinition.updateMany({ where: { id: parsed.data.ids[i], entity: "contact" }, data: { order: i } });
      }
      return { ok: true };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("contacts:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const field = await tx.customFieldDefinition.findUnique({ where: { id } });
      if (!field || field.entity !== "contact") throw new NotFoundException("Campo no encontrado");
      const inUse = await tx.customFieldValue.count({ where: { definitionId: id } });
      if (inUse > 0) {
        throw new BadRequestException(`«${field.label}» tiene valores en ${inUse} contacto(s). Vacíalos antes de eliminar el campo.`);
      }
      await tx.customFieldDefinition.delete({ where: { id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.contact_field_delete", entityType: "custom_field", entityId: id, after: { key: field.key } },
      });
      return { ok: true };
    });
  }
}
