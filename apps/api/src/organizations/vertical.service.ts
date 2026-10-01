import { BadRequestException, Injectable } from "@nestjs/common";
import { loadVerticalData } from "@conversia/database";
import { PrismaService } from "../prisma.service";

/**
 * Instalador de PAQUETES VERTICALES (F2). Lee la plantilla global del catálogo con el
 * cliente admin (RLS oculta las filas org_id NULL al rol de app) e instala sus DATOS
 * en el tenant dentro de UNA transacción con RLS (withTenant). Idempotente (los loaders
 * hacen upsert) y "aplica el rubro" escribiéndolo en settings (lo consume
 * resolvePersonalization). Los agentes/flujos quedan en BORRADOR (publish:false): el
 * equipo o el montaje asistido los publica tras personalizar.
 */
@Injectable()
export class VerticalService {
  constructor(private prisma: PrismaService) {}

  async install(organizationId: string, key: string, version?: number): Promise<{ key: string; version: number }> {
    const admin = this.prisma.admin;
    const tpl = version
      ? await admin.verticalTemplate.findUnique({ where: { key_version: { key, version } } })
      : await admin.verticalTemplate.findFirst({ where: { key, active: true }, orderBy: { version: "desc" } });
    if (!tpl || !tpl.active) {
      throw new BadRequestException(`No hay un paquete vertical activo para el rubro "${key}".`);
    }
    const definition = (tpl.definition ?? {}) as Record<string, any>;

    await this.prisma.withTenant(organizationId, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true, currency: true, settings: true },
      });
      // Datos del rubro (borrador). Loaders compartidos con el seed.
      await loadVerticalData(
        tx,
        organizationId,
        { timezone: org?.timezone ?? "America/Santiago", currency: org?.currency ?? "CLP" },
        definition,
        { publish: false },
      );
      // Aplica el rubro en settings (merge, no pisa otras claves): industry (lo lee
      // resolvePersonalization) + horarios + overrides opcionales que traiga el paquete.
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const nextSettings: Record<string, any> = {
        ...settings,
        general: { ...(settings.general ?? {}), industry: definition.industry ?? key },
        vertical: { key: tpl.key, version: tpl.version, installedAt: new Date().toISOString() },
      };
      if (definition.businessHours) nextSettings.businessHours = definition.businessHours;
      if (definition.vocabulary) nextSettings.vocabulary = { ...(settings.vocabulary ?? {}), ...definition.vocabulary };
      if (definition.modules) nextSettings.modules = { ...(settings.modules ?? {}), ...definition.modules };
      await tx.organization.update({ where: { id: organizationId }, data: { settings: nextSettings as object } });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorType: "system",
          action: "vertical.install",
          entityType: "vertical_template",
          entityId: tpl.id,
          after: { key: tpl.key, version: tpl.version },
        },
      });
    });

    return { key: tpl.key, version: tpl.version };
  }
}
