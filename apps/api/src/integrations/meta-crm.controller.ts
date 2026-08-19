import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { fetchGraphWithProof, getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { requirePermission } from "../tenancy/permissions";

// Scopes que necesita el CRM de Lead Ads (acceso estándar alcanza para los
// activos del propio Business del token).
const REQUIRED_SCOPES = ["pages_show_list", "leads_retrieval"];
const RECOMMENDED_SCOPES = ["pages_manage_metadata", "pages_manage_ads", "pages_read_engagement", "business_management"];

/**
 * Integración «Meta CRM» (Lead Ads → CRM → dataset), SEPARADA de la conexión
 * Meta general del tenant (ads/CAPI/WhatsApp): app de Meta distinta ("TuBot
 * CRM"), token distinto y conexión propia (`meta_crm_connections`) — conectar
 * o desconectar el CRM jamás toca la otra integración. El webhook de leads y
 * la lectura/CAPI del worker prefieren este token y caen al general si no hay.
 */
@Controller("integrations/meta-crm")
export class MetaCrmController {
  constructor(private prisma: PrismaService) {}

  private async graph(path: string, token: string, init?: RequestInit): Promise<any> {
    const v = getEnv().META_GRAPH_VERSION;
    const res = await fetchGraphWithProof(
      `https://graph.facebook.com/${v}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      token,
      init,
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new BadRequestException(json?.error?.message ?? `Graph ${res.status}`);
    return json;
  }

  /** Token de la conexión Meta CRM del tenant (NO usa la conexión general). */
  private async crmToken(orgId: string): Promise<string> {
    const token = await this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.metaCrmConnection.findUnique({ where: { organizationId: orgId } });
      if (conn?.status === "CONNECTED" && conn.credentialId) {
        const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
        if (cred) return decryptSecret(cred.ciphertext);
      }
      return null;
    });
    if (!token) throw new BadRequestException("Conecta Meta CRM primero (token de Usuario del Sistema de la app CRM).");
    return token;
  }

  /** Estado de la integración: conexión, página(s), formularios, mapeo, dataset. */
  @Get()
  status() {
    const ctx = requirePermission("integrations:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [conn, pages, forms, mapping, eventMapping] = await Promise.all([
        tx.metaCrmConnection.findUnique({ where: { organizationId: ctx.organizationId } }),
        tx.metaAsset.findMany({ where: { kind: "page" }, orderBy: { name: "asc" } }),
        tx.metaAsset.findMany({ where: { kind: "lead_form" }, orderBy: { name: "asc" } }),
        tx.metaFieldMapping.findFirst({ where: { formExternalId: null } }),
        tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } }),
      ]);
      return {
        connection: conn
          ? { status: conn.status, mode: conn.mode, businessName: conn.businessName, scopes: (conn.appScopes as string[]) ?? [], lastError: conn.lastError }
          : null,
        pages: pages.map((p) => ({ externalId: p.externalId, name: p.name, enabled: p.enabled })),
        forms: forms.map((f) => ({ externalId: f.externalId, name: f.name })),
        mappingActive: Boolean(mapping?.active),
        datasetReady: Boolean(eventMapping?.datasetId && eventMapping?.active !== false),
      };
    });
  }

  /** Valida un token contra Graph SIN guardarlo (dry-run con scopes de leads). */
  @Post("token/validate")
  async validateToken(@Body() body: unknown) {
    requirePermission("integrations:write");
    const parsed = z.object({ accessToken: z.string().trim().min(20) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("accessToken requerido");
    try {
      const [me, perms] = await Promise.all([
        this.graph("me?fields=name", parsed.data.accessToken).catch(() => ({})),
        this.graph("me/permissions", parsed.data.accessToken),
      ]);
      const scopes: string[] = (perms.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
      const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      return {
        ok: missing.length === 0,
        name: me.name ?? null,
        scopes,
        missing,
        recommendedMissing: RECOMMENDED_SCOPES.filter((s) => !scopes.includes(s)),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message, scopes: [], missing: REQUIRED_SCOPES };
    }
  }

  /** Guarda el token (cifrado) como conexión Meta CRM del tenant. */
  @Post("token/connect")
  async connectToken(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const parsed = z.object({ accessToken: z.string().trim().min(20) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("accessToken requerido");
    const check = await this.validateToken({ accessToken: parsed.data.accessToken });
    if (!check.ok && "missing" in check && check.missing.length) {
      throw new BadRequestException(
        `Al token le faltan permisos para el CRM: ${check.missing.join(", ")}. Genera el token bajo la app CRM con esos permisos.`,
      );
    }
    if (!check.ok) throw new BadRequestException(`Token inválido: ${(check as any).error ?? "no se pudo validar"}`);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const credential = await tx.integrationCredential.create({
        data: { organizationId: ctx.organizationId, provider: "meta_crm", label: "Token Meta CRM (Lead Ads)", ciphertext: encryptSecret(parsed.data.accessToken) },
      });
      await tx.metaCrmConnection.upsert({
        where: { organizationId: ctx.organizationId },
        update: { status: "CONNECTED", mode: "MANUAL", businessName: check.name ?? "Cuenta Meta", appScopes: check.scopes, credentialId: credential.id, lastError: null },
        create: { organizationId: ctx.organizationId, status: "CONNECTED", mode: "MANUAL", businessName: check.name ?? "Cuenta Meta", appScopes: check.scopes, credentialId: credential.id, connectedById: ctx.userId },
      });
      await tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "meta_crm", type: "connection.token", status: "ok", message: `Meta CRM conectado (${check.scopes.length} permisos)` },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "meta_crm.connect", entityType: "meta_crm_connection", after: { scopes: check.scopes.length } },
      });
      return { ok: true, scopes: check.scopes, recommendedMissing: check.recommendedMissing ?? [] };
    });
  }

  /** Desconecta el CRM (no toca la conexión Meta general ni los canales). */
  @Post("disconnect")
  disconnect() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.metaCrmConnection.findUnique({ where: { organizationId: ctx.organizationId } });
      if (!conn) return { ok: true };
      if (conn.credentialId) await tx.integrationCredential.deleteMany({ where: { id: conn.credentialId } });
      await tx.metaCrmConnection.update({ where: { organizationId: ctx.organizationId }, data: { status: "DISCONNECTED", credentialId: null } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "meta_crm.disconnect", entityType: "meta_crm_connection" },
      });
      return { ok: true };
    });
  }

  /** Páginas accesibles con el token CRM + si ya están conectadas. */
  @Get("pages")
  async pages() {
    const ctx = requirePermission("integrations:read");
    const token = await this.crmToken(ctx.organizationId);
    const json = await this.graph("me/accounts?fields=id,name&limit=100", token);
    const pages: Array<{ id: string; name: string }> = (json.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
    const registered = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaAsset.findMany({ where: { kind: "page" }, select: { externalId: true } }),
    );
    const connectedIds = new Set(registered.map((r) => r.externalId));
    return { pages: pages.map((p) => ({ ...p, connected: connectedIds.has(p.id) })) };
  }

  /**
   * Conecta una página para Lead Ads con el token CRM: registra página +
   * formularios como activos (ruteo del webhook) y suscribe la app CRM a la
   * página (`subscribed_apps` con leadgen, token de página derivado).
   */
  @Post("pages/:pageId/connect")
  async connectPage(@Param("pageId") pageId: string) {
    const ctx = requirePermission("integrations:write");
    const token = await this.crmToken(ctx.organizationId);
    const page = await this.graph(`${encodeURIComponent(pageId)}?fields=id,name,access_token,instagram_business_account`, token);
    const pageToken: string | undefined = page.access_token;
    if (!pageToken) {
      throw new BadRequestException(
        "El token no da acceso de administración a esa página. Asigna la página al Usuario del Sistema (o autoriza la página al conectar) y reintenta.",
      );
    }
    // leadgen (CRM de leads) + messages (omnicanal Messenger/IG). Si el token
    // aún no trae pages_messaging, Meta ignora esos campos sin romper leadgen.
    const sub = await this.graph(`${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=leadgen,messages,messaging_postbacks`, pageToken, {
      method: "POST",
    }).catch(() => this.graph(`${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=leadgen`, pageToken, { method: "POST" }));
    const igId: string | null = page.instagram_business_account?.id ? String(page.instagram_business_account.id) : null;
    const formsJson = await this.graph(`${encodeURIComponent(pageId)}/leadgen_forms?fields=id,name,status&limit=100`, pageToken).catch(() => ({ data: [] }));
    const forms: Array<{ id: string; name: string; status: string }> = (formsJson.data ?? []).map((f: any) => ({
      id: String(f.id),
      name: String(f.name ?? f.id),
      status: String(f.status ?? ""),
    }));

    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.metaCrmConnection.findUnique({ where: { organizationId: ctx.organizationId } });
      if (!conn) throw new BadRequestException("Conecta Meta CRM primero.");
      // Los meta_assets exigen una conexión Meta general; si el tenant no la
      // tiene (solo usa el CRM), se crea una fila mínima para colgar los activos.
      let general = await tx.metaBusinessConnection.findUnique({ where: { organizationId: ctx.organizationId } });
      if (!general) {
        general = await tx.metaBusinessConnection.create({
          data: { organizationId: ctx.organizationId, status: "CONNECTED", mode: "MANUAL", businessName: conn.businessName ?? "Meta CRM", connectedById: ctx.userId },
        });
      }
      await tx.metaAsset.upsert({
        where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "page", externalId: String(page.id) } },
        update: { name: page.name ?? pageId, enabled: true },
        create: { organizationId: ctx.organizationId, connectionId: general.id, kind: "page", externalId: String(page.id), name: page.name ?? pageId, enabled: true },
      });
      for (const f of forms) {
        await tx.metaAsset.upsert({
          where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "lead_form", externalId: f.id } },
          update: { name: f.name },
          create: { organizationId: ctx.organizationId, connectionId: general.id, kind: "lead_form", externalId: f.id, name: f.name },
        });
      }
      // Cuenta de Instagram vinculada a la página → rutea los DMs de IG al tenant
      if (igId) {
        await tx.metaAsset.upsert({
          where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "instagram", externalId: igId } },
          update: { name: `IG de ${page.name ?? pageId}`, enabled: true },
          create: { organizationId: ctx.organizationId, connectionId: general.id, kind: "instagram", externalId: igId, name: `IG de ${page.name ?? pageId}`, enabled: true },
        });
      }
      await tx.integrationEvent.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "meta_crm",
          type: "page.connected",
          status: "ok",
          message: `Página «${page.name ?? pageId}» conectada al CRM: app suscrita (leadgen) + ${forms.length} formulario(s)`,
          payload: { pageId: String(page.id), forms: forms.length, subscribed: Boolean(sub?.success ?? true) } as object,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "meta_crm.page_connect", entityType: "meta_asset", entityId: String(page.id), after: { forms: forms.length } },
      });
    });
    return { ok: true, page: { id: String(page.id), name: page.name ?? pageId }, forms };
  }
}
