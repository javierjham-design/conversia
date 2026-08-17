import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

/** Audiencia del token del enlace de montaje asistido (firmado con JWT_SECRET). */
export const ASSISTED_LINK_AUD = "assisted-setup-link";

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

  /**
   * Genera el ENLACE DE UN CLIC que el bot de implementación (tenant de TuBot) le
   * manda al cliente para que autorice el montaje asistido. Solo lo puede pedir el
   * proveedor (TuBot). El token firmado lleva el contacto para ligar la conversación
   * con el org-cliente al autorizar.
   */
  @Post("generate-link")
  generateLink(@Body() body: unknown) {
    const ctx = requireContext();
    const env = getEnv();
    const providerOrgId = env.ASSISTED_SETUP_PROVIDER_ORG_ID;
    if (ctx.organizationId !== providerOrgId) {
      throw new BadRequestException("Solo el proveedor (TuBot) puede generar enlaces de montaje asistido");
    }
    const parsed = z.object({ contactId: z.string().optional(), conversationId: z.string().optional() }).safeParse(body ?? {});
    const data = parsed.success ? parsed.data : {};
    const token = jwt.sign(
      { providerOrgId, contactId: data.contactId ?? null, conversationId: data.conversationId ?? null },
      env.JWT_SECRET,
      { audience: ASSISTED_LINK_AUD, expiresIn: "2h" },
    );
    return { url: `${env.WEB_URL}/montaje-asistido?t=${encodeURIComponent(token)}`, expiresInHours: 2 };
  }

  /**
   * Autoriza el montaje asistido desde el ENLACE DE UN CLIC que el bot de
   * implementación le mandó al cliente en la conversación. Verifica el token
   * firmado (que trae el contacto de TuBot) y crea el grant LIGADO a ese contacto,
   * para que los tools del bot resuelvan el org-cliente desde la conversación.
   */
  @Post("authorize-linked")
  async authorizeLinked(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z.object({ token: z.string().min(10) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("token requerido");
    const env = getEnv();
    let payload: { providerOrgId?: string; contactId?: string; conversationId?: string };
    try {
      payload = jwt.verify(parsed.data.token, env.JWT_SECRET, { audience: ASSISTED_LINK_AUD }) as typeof payload;
    } catch {
      throw new BadRequestException("El enlace es inválido o ya expiró. Pídele al asistente uno nuevo.");
    }
    const providerOrgId = env.ASSISTED_SETUP_PROVIDER_ORG_ID;
    if (!payload.providerOrgId || payload.providerOrgId !== providerOrgId) {
      throw new BadRequestException("El enlace no corresponde a este proveedor");
    }
    if (providerOrgId === ctx.organizationId) throw new BadRequestException("El proveedor no puede autorizarse a sí mismo");
    const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
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
          linkedProviderContactId: payload.contactId ?? null,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "assisted_setup.authorize_linked",
          entityType: "assisted_setup_grant",
          entityId: grant.id,
          after: { expiresAt, linkedProviderContactId: payload.contactId ?? null },
        },
      });
      return { ok: true, authorized: true, expiresAt: grant.expiresAt };
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
