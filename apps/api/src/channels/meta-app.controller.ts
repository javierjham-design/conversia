import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { parseSignedRequest } from "./signed-request";

/**
 * Callbacks a NIVEL de APP que Meta invoca (no por-mensaje):
 *  - `deauthorize`: cuando un usuario/negocio quita la app → revocamos su
 *    conexión Meta y dejamos el canal en "reautorizar", sin borrar histórico.
 *  - `data-deletion`: solicitud de eliminación de datos → respondemos con URL
 *    de seguimiento + código, y lo registramos en audit_logs.
 * Ambos reciben un `signed_request` firmado con el App Secret (se verifica).
 */
@Controller("webhooks/meta")
export class MetaAppController {
  constructor(private prisma: PrismaService) {}

  @Post("deauthorize")
  @HttpCode(200)
  async deauthorize(@Body("signed_request") signed?: string): Promise<{ ok: boolean }> {
    const data = signed ? parseSignedRequest(signed, getEnv().META_APP_SECRET) : null;
    const metaUserId = data?.user_id ? String(data.user_id) : "";
    if (!metaUserId) return { ok: false }; // firma inválida o sin usuario → no actuar
    await this.revokeByMetaUser(metaUserId);
    return { ok: true };
  }

  @Post("data-deletion")
  @HttpCode(200)
  async dataDeletion(@Body("signed_request") signed?: string): Promise<{ url: string; confirmation_code: string }> {
    const data = signed ? parseSignedRequest(signed, getEnv().META_APP_SECRET) : null;
    const metaUserId = data?.user_id ? String(data.user_id) : "";
    const code = `del_${randomBytes(9).toString("hex")}`;
    await this.logDeletionRequest(metaUserId, code);
    // Meta exige devolver una URL donde el usuario consulta el estado + el código.
    return { url: `https://tubot.cl/legal/eliminacion-datos?code=${code}`, confirmation_code: code };
  }

  /**
   * Revoca la conexión Meta de los tenants cuyo canal fue autorizado por este
   * usuario de Meta (mapeo por `channel.config.metaUserId`, guardado al conectar).
   * Deja el canal inactivo + la MetaBusinessConnection desconectada con credencial
   * limpia, y avisa al admin. No toca conversaciones ni flujos (no rompe la bandeja).
   */
  private async revokeByMetaUser(metaUserId: string): Promise<void> {
    const channels = await this.prisma.admin.channelConnection.findMany({
      where: { config: { path: ["metaUserId"], equals: metaUserId }, status: { not: "inactive" } },
      select: { id: true, organizationId: true },
    });

    if (channels.length === 0) {
      // Sin mapeo (conexión antigua sin metaUserId) → dejar rastro de plataforma.
      await this.prisma.admin.auditLog.create({
        data: { organizationId: null, actorType: "system", actorId: "meta", action: "meta.deauthorized_unmapped", after: { metaUserId } },
      });
      return;
    }

    for (const ch of channels) {
      await this.prisma.withTenant(ch.organizationId, async (tx) => {
        await tx.channelConnection.update({ where: { id: ch.id }, data: { status: "inactive" } });
        const conn = await tx.metaBusinessConnection.findUnique({ where: { organizationId: ch.organizationId } });
        if (conn) {
          await tx.metaBusinessConnection.update({
            where: { organizationId: ch.organizationId },
            data: { status: "DISCONNECTED", lastError: "La app fue desautorizada en Meta. Reconéctala para reactivar WhatsApp.", credentialId: null },
          });
          if (conn.credentialId) await tx.integrationCredential.deleteMany({ where: { id: conn.credentialId } });
        }
        await tx.integrationEvent.create({
          data: { organizationId: ch.organizationId, provider: "meta", type: "connection.deauthorized", status: "error", message: "La app fue desautorizada desde Meta. Reconecta WhatsApp para seguir recibiendo mensajes." },
        });
        await tx.auditLog.create({
          data: { organizationId: ch.organizationId, actorType: "system", actorId: "meta", action: "meta.deauthorized", entityType: "channel_connection", entityId: ch.id, after: { metaUserId } },
        });
      });
    }
  }

  /** Registra la solicitud de eliminación de datos (por tenant si se puede mapear). */
  private async logDeletionRequest(metaUserId: string, code: string): Promise<void> {
    const channels = metaUserId
      ? await this.prisma.admin.channelConnection.findMany({
          where: { config: { path: ["metaUserId"], equals: metaUserId } },
          select: { organizationId: true },
        })
      : [];
    const orgIds = [...new Set(channels.map((c) => c.organizationId))];
    if (orgIds.length === 0) {
      await this.prisma.admin.auditLog.create({
        data: { organizationId: null, actorType: "system", actorId: "meta", action: "meta.data_deletion_request", after: { metaUserId, code } },
      });
      return;
    }
    for (const orgId of orgIds) {
      await this.prisma.withTenant(orgId, (tx) =>
        tx.auditLog.create({ data: { organizationId: orgId, actorType: "system", actorId: "meta", action: "meta.data_deletion_request", after: { metaUserId, code } } }),
      );
    }
  }
}
