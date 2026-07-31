import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { encryptSecret } from "../common/crypto";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

/** Scopes disponibles de la API pública (subconjunto acotado y documentado). */
export const API_KEY_SCOPES = ["contacts:read", "contacts:write"] as const;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Herramientas de desarrollador del tenant: webhooks ENTRANTES (URL única por
 * tenant que dispara el trigger "Webhook entrante") y API keys de la API
 * pública. Los secretos se muestran UNA sola vez al crearlos.
 */
@Controller("integrations/developers")
export class DevelopersController {
  constructor(private prisma: PrismaService) {}

  // ---------------------- Webhooks entrantes ----------------------

  @Get("inbound-webhooks")
  listInbound() {
    const ctx = requireContext();
    const env = getEnv();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const hooks = await tx.inboundWebhook.findMany({ orderBy: { createdAt: "asc" } });
      return hooks.map((h) => ({
        id: h.id,
        name: h.name,
        url: `${env.API_URL}/hooks/t/${h.token}`,
        hasSecret: Boolean(h.secretCiphertext),
        active: h.active,
        lastReceivedAt: h.lastReceivedAt,
        createdAt: h.createdAt,
      }));
    });
  }

  @Post("inbound-webhooks")
  createInbound(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const env = getEnv();
    const input = parse(z.object({ name: z.string().trim().min(2).max(60), withSecret: z.boolean().default(true) }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const token = `iwh_${randomBytes(18).toString("base64url")}`;
      const secret = input.withSecret ? `whsec_${randomBytes(24).toString("base64url")}` : null;
      const hook = await tx.inboundWebhook.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          token,
          secretCiphertext: secret ? encryptSecret(secret) : null,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "inbound_webhook.create", entityType: "inbound_webhook", entityId: hook.id, after: { name: input.name } },
      });
      // El secreto se muestra UNA vez; después solo se puede rotar.
      return { id: hook.id, name: hook.name, url: `${env.API_URL}/hooks/t/${token}`, secret };
    });
  }

  @Patch("inbound-webhooks/:id")
  updateInbound(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ active: z.boolean().optional(), name: z.string().trim().min(2).max(60).optional() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const hook = await tx.inboundWebhook.findUnique({ where: { id } });
      if (!hook) throw new NotFoundException("Webhook no encontrado");
      await tx.inboundWebhook.update({ where: { id }, data: { ...(input.active !== undefined ? { active: input.active } : {}), ...(input.name ? { name: input.name } : {}) } });
      return { ok: true };
    });
  }

  @Delete("inbound-webhooks/:id")
  deleteInbound(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.inboundWebhook.deleteMany({ where: { id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "inbound_webhook.delete", entityType: "inbound_webhook", entityId: id },
      });
      return { ok: true };
    });
  }

  // --------------------------- API keys ---------------------------

  @Get("api-keys")
  listKeys() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const keys = await tx.apiKey.findMany({ orderBy: { createdAt: "asc" } });
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        createdAt: k.createdAt,
      }));
    });
  }

  @Post("api-keys")
  createKey(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({ name: z.string().trim().min(2).max(60), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) }),
      body,
    );
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const secret = `cnvk_${randomBytes(24).toString("base64url")}`;
      const key = await tx.apiKey.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          prefix: secret.slice(0, 12),
          hash: hashApiKey(secret),
          scopes: input.scopes,
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "api_key.create", entityType: "api_key", entityId: key.id, after: { name: input.name, scopes: input.scopes } },
      });
      // El secreto completo se muestra UNA sola vez.
      return { id: key.id, name: key.name, prefix: key.prefix, scopes: input.scopes, secret };
    });
  }

  @Post("api-keys/:id/revoke")
  revokeKey(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const key = await tx.apiKey.findUnique({ where: { id } });
      if (!key) throw new NotFoundException("API key no encontrada");
      if (key.revokedAt) return { ok: true };
      await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "api_key.revoke", entityType: "api_key", entityId: id },
      });
      return { ok: true };
    });
  }
}
