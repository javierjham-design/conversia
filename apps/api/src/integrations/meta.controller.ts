import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { QUEUE_NAMES } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { encryptSecret } from "../common/crypto";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const leadMappingSchema = z.object({
  mappings: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).max(30),
  config: z
    .object({
      clinicId: z.string().nullable().optional(),
      agentSlug: z.string().nullable().optional(),
      leadStatusCode: z.string().nullable().optional(),
      tags: z.array(z.string()).max(10).optional(),
    })
    .passthrough(),
  active: z.boolean().default(true),
});

const eventMappingSchema = z.object({
  datasetId: z.string().nullable().optional(),
  testEventCode: z.string().nullable().optional(),
  active: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        source: z.string().min(1), // p.ej. "lead.status_changed:agenda" | "lead.created" | "appointment.created"
        dest: z.string().min(1), // p.ej. "AppointmentScheduled" | "Lead" | "Purchase"
        value: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        active: z.boolean().default(true),
      }),
    )
    .max(30),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

/** Centro de integraciones Meta Business Suite (por tenant). */
@Controller("integrations/meta")
export class MetaController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  @Get()
  overview() {
    const ctx = requireContext();
    const env = getEnv();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [connection, assets, numbers, channels, leadMapping, eventMapping, recentEvents] = await Promise.all([
        tx.metaBusinessConnection.findUnique({ where: { organizationId: ctx.organizationId } }),
        tx.metaAsset.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "asc" }] }),
        tx.whatsappPhoneNumber.findMany(),
        tx.channelConnection.findMany({ where: { type: "WHATSAPP_CLOUD" } }),
        tx.metaFieldMapping.findFirst({ where: { formExternalId: null } }),
        tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } }),
        tx.integrationEvent.findMany({
          where: { provider: { in: ["meta", "lead_ads", "capi", "whatsapp"] } },
          orderBy: { createdAt: "desc" },
          take: 15,
        }),
      ]);

      const defaultMapping = leadMapping;
      const byKind = (kind: string) => assets.filter((a) => a.kind === kind);
      const checklist = {
        connected: connection?.status === "CONNECTED",
        pageSelected: byKind("page").some((a) => a.enabled),
        wabaLinked: byKind("waba").length > 0 || numbers.length > 0,
        phoneConnected: numbers.length > 0 || byKind("phone_number").some((a) => a.enabled),
        webhookConfigured: true, // el endpoint /webhooks/whatsapp existe y valida firma
        leadFormsSubscribed: byKind("lead_form").some((a) => a.enabled),
        leadMappingReady: Boolean(defaultMapping?.active),
        datasetConfigured: Boolean(eventMapping?.datasetId),
        capiReady: Boolean(eventMapping?.active && eventMapping?.datasetId),
      };

      return {
        connection: connection
          ? {
              status: connection.status,
              mode: connection.mode,
              businessId: connection.businessId,
              businessName: connection.businessName,
              lastError: connection.lastError,
              updatedAt: connection.updatedAt,
            }
          : null,
        embeddedSignup: {
          // Embedded Signup real requiere app de Meta aprobada + config id.
          available: Boolean(env.META_APP_SECRET && process.env.META_APP_ID && process.env.META_CONFIG_ID),
          pendingReason:
            "Requiere app de Meta verificada con Embedded Signup aprobado (META_APP_ID + META_CONFIG_ID). Mientras tanto usa conexión manual o simulación de desarrollo.",
        },
        mockAllowed: !process.env.META_APP_ID,
        assets: {
          pages: byKind("page"),
          adAccounts: byKind("ad_account"),
          wabas: byKind("waba"),
          phoneNumbers: byKind("phone_number"),
          instagram: byKind("instagram"),
          datasets: byKind("dataset"),
          leadForms: byKind("lead_form"),
        },
        whatsapp: {
          numbers: numbers.map((n) => ({ id: n.id, phoneNumberId: n.phoneNumberId, displayPhone: n.displayPhone, status: n.status })),
          channels: channels.map((c) => ({ id: c.id, name: c.name, status: c.status })),
        },
        leadMapping: defaultMapping
          ? { mappings: defaultMapping.mappings, config: defaultMapping.config, active: defaultMapping.active }
          : null,
        eventMapping: eventMapping
          ? {
              datasetId: eventMapping.datasetId,
              testEventCode: eventMapping.testEventCode,
              rules: eventMapping.rules,
              active: eventMapping.active,
            }
          : null,
        checklist,
        recentEvents,
      };
    });
  }

  /**
   * Conexión simulada de DESARROLLO (mode=MOCK, siempre etiquetada así en UI).
   * Solo permitida mientras no exista app real configurada (META_APP_ID).
   */
  @Post("mock-connect")
  mockConnect() {
    const ctx = requirePermission("integrations:write");
    if (process.env.META_APP_ID) {
      throw new BadRequestException("Hay una app de Meta configurada: usa la conexión real");
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const connection = await tx.metaBusinessConnection.upsert({
        where: { organizationId: ctx.organizationId },
        update: { status: "CONNECTED", mode: "MOCK", businessName: "Negocio DEMO (simulado)", lastError: null },
        create: {
          organizationId: ctx.organizationId,
          status: "CONNECTED",
          mode: "MOCK",
          businessId: "demo-business",
          businessName: "Negocio DEMO (simulado)",
          connectedById: ctx.userId,
        },
      });
      const demoAssets = [
        { kind: "page", externalId: "demo-page-1", name: "Página DEMO Clínica" },
        { kind: "ad_account", externalId: "act_demo1", name: "Cuenta publicitaria DEMO" },
        { kind: "waba", externalId: "demo-waba-1", name: "WABA DEMO" },
        { kind: "phone_number", externalId: "demo-phone-1", name: "+56 9 DEMO" },
        { kind: "dataset", externalId: "demo-dataset-1", name: "Dataset conversiones DEMO" },
        { kind: "lead_form", externalId: "demo-form-implantes", name: "Formulario DEMO Implantes", meta: { pageId: "demo-page-1" } },
        { kind: "lead_form", externalId: "demo-form-ortodoncia", name: "Formulario DEMO Ortodoncia", meta: { pageId: "demo-page-1" } },
      ];
      for (const a of demoAssets) {
        await tx.metaAsset.upsert({
          where: {
            organizationId_kind_externalId: {
              organizationId: ctx.organizationId,
              kind: a.kind,
              externalId: a.externalId,
            },
          },
          update: { name: a.name },
          create: {
            organizationId: ctx.organizationId,
            connectionId: connection.id,
            kind: a.kind,
            externalId: a.externalId,
            name: a.name,
            meta: (a as any).meta ?? {},
          },
        });
      }
      await tx.integrationEvent.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "meta",
          type: "connection.mock",
          status: "warning",
          message: "Conexión SIMULADA de desarrollo creada (no envía ni recibe datos reales de Meta)",
        },
      });
      return { ok: true, mode: "MOCK" };
    });
  }

  /** Registra una conexión manual (los ids/token ya cargados vía Canales).
   *  `accessToken` (opcional) se cifra y queda como credencial PROPIA de la
   *  conexión: la usan Conversions API y Lead Ads en vez del token global —
   *  necesario cuando el global no tiene esos permisos (p. ej.
   *  whatsapp_business_manage_events). Reenviar con token = rotarlo. */
  @Post("manual-connect")
  manualConnect(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(
      z.object({
        businessId: z.string().optional(),
        businessName: z.string().optional(),
        accessToken: z.string().trim().min(10).optional(),
      }),
      body ?? {},
    );
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      let credentialId: string | undefined;
      if (input.accessToken) {
        const credential = await tx.integrationCredential.create({
          data: {
            organizationId: ctx.organizationId,
            provider: "meta",
            label: "Token conexión manual Meta",
            ciphertext: encryptSecret(input.accessToken),
          },
        });
        credentialId = credential.id;
      }
      const connection = await tx.metaBusinessConnection.upsert({
        where: { organizationId: ctx.organizationId },
        update: {
          status: "CONNECTED",
          mode: "MANUAL",
          businessId: input.businessId,
          businessName: input.businessName,
          lastError: null,
          ...(credentialId ? { credentialId } : {}),
        },
        create: {
          organizationId: ctx.organizationId,
          status: "CONNECTED",
          mode: "MANUAL",
          businessId: input.businessId,
          businessName: input.businessName ?? "Conexión manual",
          connectedById: ctx.userId,
          ...(credentialId ? { credentialId } : {}),
        },
      });
      // Deriva activos desde los números ya conectados en Canales
      const accounts = await tx.whatsappAccount.findMany({ include: { phoneNumbers: true } });
      for (const acc of accounts) {
        await tx.metaAsset.upsert({
          where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "waba", externalId: acc.wabaId } },
          update: { name: acc.name },
          create: { organizationId: ctx.organizationId, connectionId: connection.id, kind: "waba", externalId: acc.wabaId, name: acc.name },
        });
        for (const n of acc.phoneNumbers) {
          await tx.metaAsset.upsert({
            where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "phone_number", externalId: n.phoneNumberId } },
            update: { name: n.displayPhone },
            create: { organizationId: ctx.organizationId, connectionId: connection.id, kind: "phone_number", externalId: n.phoneNumberId, name: n.displayPhone },
          });
        }
      }
      return { ok: true, mode: "MANUAL" };
    });
  }

  @Post("disconnect")
  disconnect() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.metaBusinessConnection.updateMany({
        where: { organizationId: ctx.organizationId },
        data: { status: "DISCONNECTED" },
      });
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "meta", type: "connection.disconnected", status: "warning", message: "Conexión Meta desconectada por el usuario" },
      });
      return { ok: true };
    });
  }

  @Patch("assets/:id")
  toggleAsset(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ enabled: z.boolean() }), body);
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaAsset.update({ where: { id }, data: { enabled: input.enabled } }),
    );
  }

  // ---------------- Lead Ads: mapeo de campos ----------------

  @Get("lead-mapping")
  getLeadMapping() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const row = await tx.metaFieldMapping.findFirst({ where: { formExternalId: null } });
      return (
        row ?? {
          mappings: [
            { source: "full_name", target: "firstName" },
            { source: "phone_number", target: "phone" },
            { source: "email", target: "email" },
          ],
          config: { tags: ["meta-lead"] }, // sin leadStatusCode: el worker usa la primera etapa OPEN del tenant
          active: false,
        }
      );
    });
  }

  @Put("lead-mapping")
  putLeadMapping(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(leadMappingSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.metaFieldMapping.findFirst({ where: { formExternalId: null } });
      const data = { mappings: input.mappings, config: input.config as object, active: input.active };
      if (existing) return tx.metaFieldMapping.update({ where: { id: existing.id }, data });
      return tx.metaFieldMapping.create({ data: { organizationId: ctx.organizationId, formExternalId: null, ...data } });
    });
  }

  /** Simula la recepción de un lead de Meta por el pipeline REAL (worker). */
  @Post("lead-test")
  async leadTest() {
    const ctx = requirePermission("integrations:write");
    const payload = {
      object: "page",
      entry: [
        {
          id: "demo-page-1",
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: "leadgen",
              value: {
                page_id: "demo-page-1",
                form_id: "demo-form-implantes",
                leadgen_id: `test-lead-${Date.now()}`,
                created_time: Math.floor(Date.now() / 1000),
                // field_data embebido = modo prueba (el real se obtiene de Graph)
                field_data: [
                  { name: "full_name", values: ["Lead Prueba Meta"] },
                  { name: "phone_number", values: ["+56955556666"] },
                  { name: "email", values: ["lead.prueba@example.com"] },
                ],
                organization_hint: ctx.organizationId,
              },
            },
          ],
        },
      ],
    };
    // internal:true — único camino autorizado para organization_hint
    await this.queues.inbound.add("meta-lead-test", {
      raw: payload,
      receivedAt: new Date().toISOString(),
      internal: true,
    });
    return { ok: true, detail: "Lead de prueba encolado — revisa Contactos, la actividad y los workflows con trigger lead_created" };
  }

  // ---------------- Conversions API: mapeo de eventos ----------------

  @Get("event-mapping")
  getEventMapping() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const row = await tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } });
      return (
        row ?? {
          datasetId: null,
          testEventCode: null,
          active: false,
          rules: [
            { source: "lead.created", dest: "Lead", active: true },
            { source: "lead.status_changed:schedule", dest: "Schedule", active: true },
            { source: "appointment.created", dest: "Schedule", active: false },
          ],
        }
      );
    });
  }

  @Put("event-mapping")
  putEventMapping(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(eventMappingSchema, body);
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaEventMapping.upsert({
        where: { organizationId: ctx.organizationId },
        update: {
          datasetId: input.datasetId ?? null,
          testEventCode: input.testEventCode ?? null,
          rules: input.rules,
          active: input.active,
        },
        create: {
          organizationId: ctx.organizationId,
          datasetId: input.datasetId ?? null,
          testEventCode: input.testEventCode ?? null,
          rules: input.rules,
          active: input.active,
        },
      }),
    );
  }

  /** Encola un evento de prueba hacia Meta CAPI (usa test_event_code si existe). */
  @Post("capi-test")
  async capiTest(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ source: z.string().optional() }), body ?? {});
    await this.queues.capi.add("test", {
      organizationId: ctx.organizationId,
      source: input.source ?? "lead.created",
      contactPhone: "+56955556666",
      test: true,
      occurredAt: new Date().toISOString(),
    });
    return { ok: true, detail: "Evento de prueba encolado — revisa la pestaña Actividad (capi.sent o el error correspondiente)" };
  }
}
