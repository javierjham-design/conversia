import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ClarivaSchedulingProvider } from "@conversia/scheduling";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret, maskSecret } from "../common/crypto";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const clarivaSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(6),
});

const webhookSchema = z.object({
  name: z.string().min(2).max(60),
  url: z.string().url().refine((u) => u.startsWith("https://") || u.startsWith("http://localhost"), {
    message: "La URL debe ser https (o localhost en desarrollo)",
  }),
  events: z.array(z.string()).min(1),
});

export const OUTBOUND_EVENTS = [
  "conversation.started",
  "message.received",
  "message.sent",
  "lead.status_changed",
  "appointment.created",
  "human_handoff.requested",
];

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

@Controller("integrations")
export class IntegrationsController {
  constructor(private prisma: PrismaService) {}

  /** Estado de todas las integraciones del tenant + catálogo. */
  @Get()
  overview() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [scheduling, webhooks, credentials] = await Promise.all([
        tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } }),
        tx.webhookEndpoint.findMany({ orderBy: { createdAt: "asc" } }),
        tx.integrationCredential.findMany({ where: { provider: "clariva" } }),
      ]);
      const cred = scheduling?.credentialId
        ? credentials.find((c) => c.id === scheduling.credentialId)
        : null;
      return {
        clariva: scheduling
          ? {
              status: scheduling.status,
              baseUrl: (scheduling.config as any)?.baseUrl ?? null,
              apiKeyMasked: cred ? maskSecret(decryptSecret(cred.ciphertext)) : null,
              lastSyncAt: scheduling.lastSyncAt,
              lastError: scheduling.lastError,
            }
          : null,
        webhooks: webhooks.map((w) => ({
          id: w.id,
          name: w.name,
          url: w.url,
          events: w.events,
          active: w.active,
          secretMasked: maskSecret(w.secret),
        })),
        availableEvents: OUTBOUND_EVENTS,
        catalog: [
          { key: "whatsapp", name: "WhatsApp Cloud (Meta)", status: "disponible", route: "/channels" },
          { key: "clariva", name: "Cláriva (agenda clínica)", status: "disponible" },
          { key: "webhooks", name: "Webhooks salientes", status: "disponible" },
          { key: "dentalink", name: "Dentalink", status: "proximamente" },
          { key: "google_calendar", name: "Google Calendar", status: "proximamente" },
          { key: "meta_leads", name: "Meta Lead Ads", status: "proximamente" },
          { key: "sheets", name: "Google Sheets", status: "proximamente" },
        ],
      };
    });
  }

  /** Conecta (o actualiza) Cláriva como proveedor de agenda del tenant. */
  @Post("clariva")
  connectClariva(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(clarivaSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const credential = await tx.integrationCredential.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "clariva",
          label: "API key Cláriva",
          ciphertext: encryptSecret(input.apiKey),
        },
      });
      const existing = await tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } });
      const connection = existing
        ? await tx.schedulingConnection.update({
            where: { id: existing.id },
            data: { status: "active", config: { baseUrl: input.baseUrl }, credentialId: credential.id, lastError: null },
          })
        : await tx.schedulingConnection.create({
            data: {
              organizationId: ctx.organizationId,
              provider: "CLARIVA",
              status: "active",
              config: { baseUrl: input.baseUrl },
              credentialId: credential.id,
            },
          });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "integration.clariva.connect",
          entityType: "scheduling_connection",
          entityId: connection.id,
        },
      });
      return { ok: true };
    });
  }

  /** Prueba la conexión con Cláriva consultando las sedes. */
  @Post("clariva/test")
  async testClariva() {
    const ctx = requirePermission("integrations:write");
    const config = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const connection = await tx.schedulingConnection.findFirst({ where: { provider: "CLARIVA" } });
      if (!connection) throw new BadRequestException("Cláriva no está conectado");
      const cred = connection.credentialId
        ? await tx.integrationCredential.findUnique({ where: { id: connection.credentialId } })
        : null;
      return {
        connectionId: connection.id,
        baseUrl: (connection.config as any)?.baseUrl as string,
        apiKey: cred ? decryptSecret(cred.ciphertext) : "",
      };
    });

    try {
      const provider = new ClarivaSchedulingProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
      const clinics = await provider.getClinics();
      await this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.schedulingConnection.update({
          where: { id: config.connectionId },
          data: { lastSyncAt: new Date(), lastError: null },
        }),
      );
      return { ok: true, detail: `Conexión OK — ${clinics.length} sede(s): ${clinics.map((c) => c.name).join(", ")}` };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      await this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.schedulingConnection.update({ where: { id: config.connectionId }, data: { lastError: message } }),
      );
      return { ok: false, detail: message };
    }
  }

  @Delete("clariva")
  disconnectClariva() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.schedulingConnection.updateMany({ where: { provider: "CLARIVA" }, data: { status: "inactive" } });
      return { ok: true };
    });
  }

  // ---------------------- Webhooks salientes ----------------------
  // CRUD listo; la emisión de entregas se activa en la siguiente fase
  // (webhook_deliveries + reintentos) — así se documenta en la UI.

  @Post("webhooks")
  createWebhook(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(webhookSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const secret = `whsec_${randomBytes(18).toString("base64url")}`;
      const webhook = await tx.webhookEndpoint.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          url: input.url,
          secret,
          events: input.events,
        },
      });
      // El secreto completo se muestra UNA vez
      return { id: webhook.id, secret };
    });
  }

  @Patch("webhooks/:id")
  toggleWebhook(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ active: z.boolean() }), body);
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.webhookEndpoint.update({ where: { id }, data: { active: input.active } }),
    );
  }

  @Delete("webhooks/:id")
  removeWebhook(@Param("id") id: string) {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.webhookEndpoint.delete({ where: { id } });
      return { ok: true };
    });
  }
}
