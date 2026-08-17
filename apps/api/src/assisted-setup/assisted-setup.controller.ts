import { BadRequestException, Controller, Get, Post } from "@nestjs/common";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

/**
 * MONTAJE ASISTIDO — autorización del CLIENTE (dueño de su tenant) para que TuBot
 * escriba SOLO su configuración (agentes, flujos, servicios, base de conocimiento)
 * durante la implementación acompañada. El cliente la concede y la revoca cuando
 * quiera. Vigencia 14 días; volver a autorizar = renovar (para reimplementaciones).
 *
 * La escritura real la hace el agente de implementación de TuBot a través del
 * contexto acotado (`openAssistedSetup` en el worker), que verifica este grant y
 * NUNCA accede a conversaciones/contactos ni envía en nombre del cliente.
 */
const SCOPES = ["agents", "flows", "services", "knowledge"] as const;

@Controller("assisted-setup")
export class AssistedSetupController {
  constructor(private prisma: PrismaService) {}

  /** Estado de la autorización del cliente (para mostrar el interruptor en su panel). */
  @Get("status")
  status() {
    const ctx = requireContext();
    const providerOrgId = getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const grant = await tx.assistedSetupGrant.findFirst({
        where: { grantedByOrganizationId: providerOrgId },
        orderBy: { createdAt: "desc" },
      });
      const active = grant?.status === "active" && grant.expiresAt.getTime() > Date.now();
      return {
        authorized: active,
        status: grant?.status ?? null,
        expiresAt: active ? grant!.expiresAt : null,
        scopes: active ? (grant!.scopes as string[]) : [],
      };
    });
  }

  /** Autoriza (o RENUEVA) el montaje asistido por 14 días. */
  @Post("authorize")
  async authorize() {
    const ctx = requirePermission("settings:write");
    const providerOrgId = getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID;
    if (!providerOrgId) throw new BadRequestException("El montaje asistido no está configurado");
    if (providerOrgId === ctx.organizationId) {
      throw new BadRequestException("El proveedor no puede autorizarse a sí mismo");
    }
    const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // Renovar = revocar los activos previos y crear uno nuevo con nueva vigencia.
      await tx.assistedSetupGrant.updateMany({
        where: { grantedByOrganizationId: providerOrgId, status: "active" },
        data: { status: "revoked", revokedAt: new Date() },
      });
      const grant = await tx.assistedSetupGrant.create({
        data: {
          organizationId: ctx.organizationId,
          grantedByOrganizationId: providerOrgId,
          scopes: [...SCOPES],
          status: "active",
          authorizedByUserId: ctx.userId,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "assisted_setup.authorize",
          entityType: "assisted_setup_grant",
          entityId: grant.id,
          after: { expiresAt, scopes: [...SCOPES] },
        },
      });
      return { ok: true, authorized: true, expiresAt: grant.expiresAt, scopes: [...SCOPES] };
    });
  }

  /** Revoca el montaje asistido — corta el acceso de TuBot de inmediato. */
  @Post("revoke")
  async revoke() {
    const ctx = requirePermission("settings:write");
    const providerOrgId = getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.assistedSetupGrant.updateMany({
        where: { grantedByOrganizationId: providerOrgId, status: "active" },
        data: { status: "revoked", revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "assisted_setup.revoke",
          entityType: "assisted_setup_grant",
        },
      });
      return { ok: true, authorized: false };
    });
  }
}
