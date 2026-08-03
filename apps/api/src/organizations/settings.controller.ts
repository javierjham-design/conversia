import { BadRequestException, Body, Controller, Get, Put } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const generalSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  timezone: z.string().min(3).max(60).optional(),
  logoUrl: z.string().url().max(500).optional().or(z.literal("")),
  industry: z.string().max(60).optional(),
  currency: z.string().length(3).optional(), // ISO 4217: CLP, USD…
  language: z.enum(["es", "en", "pt"]).optional(),
  contactEmail: z.string().email().max(120).optional().or(z.literal("")),
  contactPhone: z.string().max(30).optional(),
  website: z.string().url().max(200).optional().or(z.literal("")),
});

/**
 * Centro de Configuración del tenant (/settings) — Información general.
 * UNA fuente de verdad: organization.name/timezone + organization.settings.general.
 * Consumidores: zona horaria → agenda, resumen diario de correo y default del
 * nodo «Fecha y hora»; moneda → default de servicios nuevos (no pisa el
 * currency por servicio); idioma → asistente del compositor.
 */
@Controller("settings")
export class SettingsController {
  constructor(private prisma: PrismaService) {}

  @Get("general")
  general() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const general = (settings.general ?? {}) as Record<string, any>;
      return {
        name: org?.name ?? "",
        slug: org?.slug ?? "",
        timezone: org?.timezone ?? "America/Santiago",
        logoUrl: general.logoUrl ?? "",
        industry: general.industry ?? "",
        currency: general.currency ?? "CLP",
        language: general.language ?? "es",
        contactEmail: general.contactEmail ?? "",
        contactPhone: general.contactPhone ?? "",
        website: general.website ?? "",
      };
    });
  }

  @Put("general")
  updateGeneral(@Body() body: unknown) {
    const ctx = requirePermission("settings:write"); // owner/admin (permiso "*")
    const parsed = generalSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Datos inválidos");
    const input = parsed.data;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      if (!org) throw new BadRequestException("Organización no encontrada");
      const settings = (org.settings ?? {}) as Record<string, any>;
      const general = { ...((settings.general ?? {}) as object) } as Record<string, any>;
      for (const key of ["logoUrl", "industry", "currency", "language", "contactEmail", "contactPhone", "website"] as const) {
        if (input[key] !== undefined) general[key] = input[key];
      }
      await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          settings: { ...settings, general } as object,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "settings.general_update",
          entityType: "organization",
          entityId: ctx.organizationId,
          after: input as object,
        },
      });
      return { ok: true };
    });
  }
}
