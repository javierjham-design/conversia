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
import { getEnv, withAppSecretProof } from "@conversia/config";
import { QUEUE_NAMES } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { decryptSecret, encryptSecret } from "../common/crypto";
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

  /** Inspecciona un token contra Graph: permisos otorgados + cuentas publicitarias. */
  private async inspectToken(token: string): Promise<{ scopes: string[]; adAccounts: { id: string; name: string; status: number }[]; name: string | null }> {
    const v = getEnv().META_GRAPH_VERSION;
    const g = async (path: string) => {
      const res = await fetch(withAppSecretProof(`https://graph.facebook.com/${v}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, token));
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? `Graph ${res.status}`);
      return json;
    };
    const [me, perms, accounts] = await Promise.all([
      g("me?fields=name").catch(() => ({})),
      g("me/permissions"),
      g("me/adaccounts?fields=id,name,account_status&limit=200").catch(() => ({ data: [] })),
    ]);
    const scopes: string[] = (perms.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
    const adAccounts = (accounts.data ?? []).map((a: any) => ({ id: String(a.id), name: String(a.name ?? a.id), status: Number(a.account_status ?? 0) }));
    return { scopes, adAccounts, name: me.name ?? null };
  }

  /** Valida un token (dry-run): muestra permisos y cuentas publicitarias, sin guardar. */
  @Post("token/validate")
  async validateToken(@Body() body: unknown) {
    requirePermission("integrations:write");
    const input = parse(z.object({ accessToken: z.string().trim().min(20) }), body ?? {});
    try {
      const info = await this.inspectToken(input.accessToken);
      return {
        ok: true,
        ...info,
        hasAdsRead: info.scopes.includes("ads_read"),
        hasBusinessManagement: info.scopes.includes("business_management"),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Guarda un token de Usuario del Sistema (permanente) como conexión Meta. */
  @Post("token/connect")
  async connectToken(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ accessToken: z.string().trim().min(20), adAccountIds: z.array(z.string()).optional() }), body ?? {});
    const info = await this.inspectToken(input.accessToken).catch((e) => {
      throw new BadRequestException(`Token inválido: ${(e as Error).message}`);
    });
    if (!info.scopes.includes("ads_read") && info.adAccounts.length === 0) {
      throw new BadRequestException("El token no trae ads_read ni acceso a cuentas publicitarias. Revisa los permisos del Usuario del Sistema en Business Manager.");
    }
    const pick = input.adAccountIds?.length ? info.adAccounts.filter((a) => input.adAccountIds!.includes(a.id)) : info.adAccounts;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const credential = await tx.integrationCredential.create({
        data: { organizationId: ctx.organizationId, provider: "meta", label: "Token Usuario del Sistema (Meta)", ciphertext: encryptSecret(input.accessToken) },
      });
      const connection = await tx.metaBusinessConnection.upsert({
        where: { organizationId: ctx.organizationId },
        update: { status: "CONNECTED", mode: "MANUAL", businessName: info.name ?? "Cuenta Meta", appScopes: info.scopes, credentialId: credential.id, lastError: null },
        create: { organizationId: ctx.organizationId, status: "CONNECTED", mode: "MANUAL", businessName: info.name ?? "Cuenta Meta", appScopes: info.scopes, credentialId: credential.id, connectedById: ctx.userId },
      });
      for (const a of pick) {
        await tx.metaAsset.upsert({
          where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "ad_account", externalId: a.id } },
          update: { name: a.name, enabled: true },
          create: { organizationId: ctx.organizationId, connectionId: connection.id, kind: "ad_account", externalId: a.id, name: a.name, enabled: true },
        });
      }
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "meta", type: "connection.token", status: "ok", message: `Token cargado: ${info.scopes.length} permisos, ${pick.length} cuenta(s) publicitaria(s).` },
      });
      return { ok: true, scopes: info.scopes, adAccounts: pick.length, hasAdsRead: info.scopes.includes("ads_read") };
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

  // ---------------- Lead Ads: páginas y formularios ----------------

  /** Token de la conexión Meta del tenant (Usuario del Sistema o manual). */
  private async metaToken(orgId: string): Promise<string> {
    const token = await this.prisma.withTenant(orgId, async (tx) => {
      const connection = await tx.metaBusinessConnection.findUnique({ where: { organizationId: orgId } });
      if (connection?.credentialId) {
        const cred = await tx.integrationCredential.findUnique({ where: { id: connection.credentialId } });
        if (cred) return decryptSecret(cred.ciphertext);
      }
      return getEnv().META_ACCESS_TOKEN || null;
    });
    if (!token) throw new BadRequestException("Conecta Meta primero (token de Usuario del Sistema) en este centro.");
    return token;
  }

  private async graph(path: string, token: string, init?: RequestInit): Promise<any> {
    const v = getEnv().META_GRAPH_VERSION;
    const url = withAppSecretProof(
      `https://graph.facebook.com/${v}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      token,
    );
    const res = await fetch(url, init);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(json?.error?.message ?? `Graph ${res.status}`);
    return json;
  }

  /** Páginas accesibles con el token + si ya están conectadas (asset registrado). */
  @Get("lead-ads/pages")
  async leadAdsPages() {
    const ctx = requirePermission("integrations:read");
    const token = await this.metaToken(ctx.organizationId);
    const json = await this.graph("me/accounts?fields=id,name&limit=100", token);
    const pages: Array<{ id: string; name: string }> = (json.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
    const registered = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaAsset.findMany({ where: { kind: "page" }, select: { externalId: true } }),
    );
    const connectedIds = new Set(registered.map((r) => r.externalId));
    return { pages: pages.map((p) => ({ ...p, connected: connectedIds.has(p.id) })) };
  }

  /**
   * Conecta una página para Lead Ads: registra la página y sus formularios como
   * activos (ruteo del webhook leadgen → este tenant) y suscribe la app a la
   * página (`subscribed_apps` con el campo leadgen, token de página derivado).
   */
  @Post("lead-ads/pages/:pageId/connect")
  async leadAdsConnectPage(@Param("pageId") pageId: string) {
    const ctx = requirePermission("integrations:write");
    const token = await this.metaToken(ctx.organizationId);
    // Token de página (necesario para subscribed_apps y leadgen_forms)
    const page = await this.graph(`${encodeURIComponent(pageId)}?fields=id,name,access_token`, token);
    const pageToken: string | undefined = page.access_token;
    if (!pageToken) {
      throw new BadRequestException(
        "El token no da acceso de administración a esa página. Asigna la página al Usuario del Sistema en Business Manager y reintenta.",
      );
    }
    // Suscripción de la app a la página (campo leadgen) — idempotente en Graph.
    const sub = await this.graph(`${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=leadgen`, pageToken, { method: "POST" });
    // Formularios activos de la página
    const formsJson = await this.graph(`${encodeURIComponent(pageId)}/leadgen_forms?fields=id,name,status&limit=100`, pageToken).catch(() => ({ data: [] }));
    const forms: Array<{ id: string; name: string; status: string }> = (formsJson.data ?? []).map((f: any) => ({
      id: String(f.id),
      name: String(f.name ?? f.id),
      status: String(f.status ?? ""),
    }));

    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const connection = await tx.metaBusinessConnection.findUnique({ where: { organizationId: ctx.organizationId } });
      if (!connection) throw new BadRequestException("Conecta Meta primero en este centro (el token queda asociado a la conexión).");
      await tx.metaAsset.upsert({
        where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "page", externalId: String(page.id) } },
        update: { name: page.name ?? pageId, enabled: true },
        create: { organizationId: ctx.organizationId, connectionId: connection.id, kind: "page", externalId: String(page.id), name: page.name ?? pageId, enabled: true },
      });
      for (const f of forms) {
        await tx.metaAsset.upsert({
          where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "lead_form", externalId: f.id } },
          update: { name: f.name },
          create: { organizationId: ctx.organizationId, connectionId: connection.id, kind: "lead_form", externalId: f.id, name: f.name },
        });
      }
      await tx.integrationEvent.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "lead_ads",
          type: "page.connected",
          status: "ok",
          message: `Página «${page.name ?? pageId}» conectada para Lead Ads: app suscrita (leadgen) + ${forms.length} formulario(s) registrados`,
          payload: { pageId: String(page.id), forms: forms.length, subscribed: Boolean(sub?.success ?? true) } as object,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "meta.leadads.page_connect", entityType: "meta_asset", entityId: String(page.id), after: { forms: forms.length } },
      });
    });
    return { ok: true, page: { id: String(page.id), name: page.name ?? pageId }, forms };
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

  /**
   * Encola un evento de prueba hacia Meta CAPI. Va en modo DIRECTO (eventName
   * "Lead"), así verifica dataset + token + test_event_code aunque el tenant
   * todavía no haya configurado reglas source→evento. Con test_event_code el
   * evento aparece en la pestaña "Eventos de prueba" del Events Manager.
   */
  @Post("capi-test")
  async capiTest(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const input = parse(z.object({ eventName: z.string().min(1).max(60).optional() }), body ?? {});
    const mapping = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } }),
    );
    if (!mapping?.datasetId) {
      throw new BadRequestException("Configura primero el dataset de conversiones en la pestaña Conversions API");
    }
    await this.queues.capi.add("test", {
      organizationId: ctx.organizationId,
      source: "test",
      eventName: input.eventName ?? "Lead",
      contactPhone: "+56955556666",
      test: true,
      occurredAt: new Date().toISOString(),
    });
    return {
      ok: true,
      detail: mapping.testEventCode
        ? "Evento de prueba enviado — míralo en la pestaña «Eventos de prueba» del Events Manager (y en Actividad)."
        : "Evento de prueba enviado. Sugerencia: define un test_event_code para verlo en tiempo real en «Eventos de prueba» del Events Manager.",
    };
  }

  // ------------------------- Catálogo de anuncios -------------------------

  /** Cuentas publicitarias del tenant (para elegir cuáles sincroniza). */
  @Get("ads/accounts")
  async adAccounts() {
    const ctx = requirePermission("integrations:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [accounts, connection] = await Promise.all([
        tx.metaAsset.findMany({ where: { kind: "ad_account" }, orderBy: { name: "asc" } }),
        tx.metaBusinessConnection.findUnique({ where: { organizationId: ctx.organizationId } }),
      ]);
      const scopes: string[] = Array.isArray(connection?.appScopes) ? (connection!.appScopes as string[]) : [];
      return {
        connected: connection?.status === "CONNECTED",
        // ads_read es lo que habilita listar/sincronizar anuncios (App Review en prod).
        canReadAds: scopes.includes("ads_read"),
        accounts: accounts.map((a) => ({ id: a.id, externalId: a.externalId, name: a.name, enabled: a.enabled })),
      };
    });
  }

  /** Dispara una sincronización del catálogo de anuncios (botón "Sincronizar ahora"). */
  @Post("ads/sync")
  async adsSync() {
    const ctx = requirePermission("integrations:write");
    const connection = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaBusinessConnection.findUnique({ where: { organizationId: ctx.organizationId } }),
    );
    if (connection?.status !== "CONNECTED") {
      throw new BadRequestException("Conecta Meta y autoriza los anuncios (ads_read) antes de sincronizar.");
    }
    await this.queues.sync.add("meta_ads_sync", { organizationId: ctx.organizationId, kind: "meta_ads_sync", payload: {} });
    return { ok: true, detail: "Sincronización encolada — el catálogo se actualizará en unos segundos." };
  }

  /**
   * Árbol del catálogo para el trigger: campaña → conjunto → anuncio, con nombres,
   * estado (activo/pausado), si es Click-to-WhatsApp y si sigue disponible.
   */
  @Get("ads/catalog")
  async adsCatalog(@Query("adAccountId") adAccountId?: string) {
    const ctx = requirePermission("integrations:read");
    const ads = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaAd.findMany({
        where: adAccountId ? { adAccountId } : {},
        orderBy: [{ campaignName: "asc" }, { adsetName: "asc" }, { adName: "asc" }],
      }),
    );
    // Agrupa en árbol campaña → conjunto → anuncio.
    const campaigns = new Map<string, any>();
    for (const a of ads) {
      let c = campaigns.get(a.campaignId);
      if (!c) {
        c = { id: a.campaignId, name: a.campaignName, objective: a.objective, adsets: new Map<string, any>() };
        campaigns.set(a.campaignId, c);
      }
      let s = c.adsets.get(a.adsetId);
      if (!s) {
        s = { id: a.adsetId, name: a.adsetName, ads: [] as any[] };
        c.adsets.set(a.adsetId, s);
      }
      s.ads.push({ id: a.adExternalId, name: a.adName, status: a.status, isCtwa: a.isCtwa, available: a.available });
    }
    const tree = [...campaigns.values()].map((c) => ({
      id: c.id, name: c.name, objective: c.objective,
      adsets: [...c.adsets.values()],
    }));
    const lastSyncedAt = ads.reduce<string | null>((max, a) => {
      const t = a.lastSyncedAt.toISOString();
      return !max || t > max ? t : max;
    }, null);
    return { total: ads.length, lastSyncedAt, campaigns: tree };
  }
}
