import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { fetchGraphWithProof, getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { requirePermission } from "../tenancy/permissions";
import { signState, verifyState } from "./oauth.controller";

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
        forms: forms.map((f) => ({ externalId: f.externalId, name: f.name, pageId: ((f.meta as Record<string, unknown>) ?? {}).pageId ?? null })),
        mappingActive: Boolean(mapping?.active),
        datasetReady: Boolean(eventMapping?.datasetId && eventMapping?.active !== false),
      };
    });
  }

  // ---------- OAuth "Conectar con Meta" (sin pegar tokens) ----------

  /** URL del diálogo de autorización de la app CRM (el tenant hace 1 clic). */
  @Get("oauth/authorize")
  oauthAuthorize() {
    const ctx = requirePermission("integrations:write");
    const env = getEnv();
    if (!env.META_CRM_APP_ID) {
      throw new BadRequestException("OAuth de Meta CRM no configurado en la plataforma (META_CRM_APP_ID). Usa el token manual mientras tanto.");
    }
    const params = new URLSearchParams({
      client_id: env.META_CRM_APP_ID,
      redirect_uri: `${env.API_URL}/public/oauth/meta-crm/callback`,
      state: signState(ctx.organizationId),
      response_type: "code",
    });
    // Con configuración de Login for Business, los scopes los define la config.
    if (env.META_CRM_CONFIG_ID) params.set("config_id", env.META_CRM_CONFIG_ID);
    else params.set("scope", [...REQUIRED_SCOPES, ...RECOMMENDED_SCOPES, "pages_messaging", "instagram_basic", "instagram_manage_messages"].join(","));
    return { url: `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth?${params.toString()}` };
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
    // Foto vía la URL PÚBLICA estable de Graph (no caduca, a diferencia de las
    // URLs firmadas de scontent que expiran en semanas).
    const v = getEnv().META_GRAPH_VERSION;
    const pages: Array<{ id: string; name: string; pictureUrl: string | null }> = (json.data ?? []).map((p: any) => ({
      id: String(p.id),
      name: String(p.name ?? p.id),
      pictureUrl: `https://graph.facebook.com/${v}/${encodeURIComponent(String(p.id))}/picture?width=240&height=240`,
    }));
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
    // URL pública ESTABLE de la foto de página (no caduca como las firmadas de scontent)
    const pagePictureUrl = `https://graph.facebook.com/${getEnv().META_GRAPH_VERSION}/${encodeURIComponent(String(page.id))}/picture?width=240&height=240`;
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
    // El canal IG se nombra por su @usuario real (no por la página): la cuenta
    // que ve el cliente es @usuario, y así aparece en Canales y en la bandeja.
    let igUsername: string | null = null;
    let igPictureUrl: string | null = null;
    if (igId) {
      const ig = await this.graph(`${encodeURIComponent(igId)}?fields=username,profile_picture_url`, pageToken).catch(() => null);
      igUsername = ig?.username ? String(ig.username) : null;
      igPictureUrl = ig?.profile_picture_url ? String(ig.profile_picture_url) : null;
    }
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
          update: { name: f.name, meta: { pageId: String(page.id) } },
          create: { organizationId: ctx.organizationId, connectionId: general.id, kind: "lead_form", externalId: f.id, name: f.name, meta: { pageId: String(page.id) } },
        });
      }
      // Cuenta de Instagram vinculada a la página → rutea los DMs de IG al tenant
      if (igId) {
        const igAssetName = igUsername ? `@${igUsername}` : `IG de ${page.name ?? pageId}`;
        await tx.metaAsset.upsert({
          where: { organizationId_kind_externalId: { organizationId: ctx.organizationId, kind: "instagram", externalId: igId } },
          update: { name: igAssetName, enabled: true },
          create: { organizationId: ctx.organizationId, connectionId: general.id, kind: "instagram", externalId: igId, name: igAssetName, enabled: true },
        });
      }
      // Canales visibles en Canales desde ya (no esperar el primer DM)
      const chans = await tx.channelConnection.findMany({ where: { type: { in: ["MESSENGER", "INSTAGRAM"] as any } } });
      const findChan = (t: string) => chans.find((c) => c.type === (t as any) && String((c.config as any)?.pageId ?? "") === String(page.id));
      const existingMsgr = findChan("MESSENGER");
      if (!existingMsgr) {
        await tx.channelConnection.create({
          data: {
            organizationId: ctx.organizationId,
            type: "MESSENGER" as any,
            name: `Messenger · ${page.name ?? pageId}`,
            status: "active",
            config: { pageId: String(page.id), ...(pagePictureUrl ? { pictureUrl: pagePictureUrl } : {}) } as object,
          },
        });
      } else if (pagePictureUrl && (existingMsgr.config as any)?.pictureUrl !== pagePictureUrl) {
        // Re-conectar refresca la foto de perfil de la página (pages_read_engagement)
        await tx.channelConnection.update({
          where: { id: existingMsgr.id },
          data: { config: { ...((existingMsgr.config as any) ?? {}), pictureUrl: pagePictureUrl } as object },
        });
      }
      if (igId) {
        const igChanName = igUsername ? `Instagram · @${igUsername}` : `Instagram · ${page.name ?? pageId}`;
        const existingIg = findChan("INSTAGRAM");
        if (!existingIg) {
          await tx.channelConnection.create({
            data: {
              organizationId: ctx.organizationId,
              type: "INSTAGRAM" as any,
              name: igChanName,
              status: "active",
              config: { pageId: String(page.id), igId, ...(igPictureUrl ? { pictureUrl: igPictureUrl } : {}) } as object,
            },
          });
        } else if (
          existingIg.name !== igChanName ||
          String((existingIg.config as any)?.igId ?? "") !== igId ||
          (igPictureUrl && (existingIg.config as any)?.pictureUrl !== igPictureUrl)
        ) {
          // Re-conectar corrige nombre, igId y foto de perfil de la cuenta
          await tx.channelConnection.update({
            where: { id: existingIg.id },
            data: { name: igChanName, config: { ...((existingIg.config as any) ?? {}), pageId: String(page.id), igId, ...(igPictureUrl ? { pictureUrl: igPictureUrl } : {}) } as object },
          });
        }
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

  /**
   * Diagnóstico de mensajería de una página (estilo "Probar conexión" de
   * WhatsApp): consulta a Graph CADA eslabón y devuelve qué está bien y qué
   * falta, con el arreglo sugerido — sin adivinar por qué no llegan los DMs.
   */
  @Get("pages/:pageId/diagnose")
  async diagnosePage(@Param("pageId") pageId: string) {
    const ctx = requirePermission("integrations:read");
    const env = getEnv();
    const checks: Array<{ key: string; label: string; ok: boolean; detail: string; fix?: string }> = [];
    const push = (key: string, label: string, ok: boolean, detail: string, fix?: string) => checks.push({ key, label, ok, detail, fix });

    // 1. Conexión + scopes de mensajería
    let token: string | null = null;
    try {
      token = await this.crmToken(ctx.organizationId);
    } catch {
      push("token", "Conexión Meta CRM", false, "Sin token de la conexión CRM", "Conecta con Meta (o token manual) en esta página");
      return { checks };
    }
    // 0. ¿A qué APP pertenece el token? Crítico para App Review: las llamadas
    // de prueba solo activan los botones de acceso avanzado de la app EMISORA.
    // Un token de Usuario del Sistema generado bajo la app de WhatsApp haría
    // que todo el diagnóstico cuente para la app equivocada.
    try {
      const app = await this.graph(`app?fields=id,name`, token);
      const expected = env.META_CRM_APP_ID ?? null;
      const okApp = !expected || String(app.id) === String(expected);
      push(
        "token_app",
        "App emisora del token",
        okApp,
        `Token emitido por «${app.name ?? "?"}» (${app.id})${expected ? ` · esperada: ${expected}` : ""}`,
        okApp ? undefined : "El token NO es de la app TuBot CRM: reconecta con «Conectar con Meta» (OAuth) o genera el token de Usuario del Sistema seleccionando la app TuBot CRM — si no, las llamadas de prueba de App Review cuentan para otra app",
      );
    } catch {
      push("token_app", "App emisora del token", false, "No se pudo consultar /app con el token", "Reconecta la integración");
    }

    const conn = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaCrmConnection.findUnique({ where: { organizationId: ctx.organizationId } }),
    );
    const scopes: string[] = Array.isArray(conn?.appScopes) ? (conn!.appScopes as string[]) : [];
    const needMsg = ["pages_messaging", "instagram_basic", "instagram_manage_messages"].filter((s) => !scopes.includes(s));
    push(
      "scopes",
      "Permisos de mensajería en el token",
      needMsg.length === 0,
      needMsg.length ? `Faltan: ${needMsg.join(", ")}` : `${scopes.length} permisos, mensajería incluida`,
      needMsg.length ? "Vuelve a Conectar con Meta y acepta TODOS los permisos" : undefined,
    );

    // 2. Token de página + vínculo IG
    let pageToken: string | null = null;
    let igId: string | null = null;
    try {
      const page = await this.graph(`${encodeURIComponent(pageId)}?fields=id,name,access_token,instagram_business_account`, token);
      pageToken = page.access_token ?? null;
      igId = page.instagram_business_account?.id ? String(page.instagram_business_account.id) : null;
      push("page_token", "Acceso de administración a la página", Boolean(pageToken), pageToken ? `Página «${page.name}» accesible` : "El token no devuelve access_token de la página", pageToken ? undefined : "Autoriza la página al Conectar con Meta (o asígnala al Usuario del Sistema)");
      push("ig_link", "Instagram vinculado a la página", Boolean(igId), igId ? `Cuenta IG ${igId} vinculada` : "La página no tiene cuenta de Instagram vinculada", igId ? undefined : "Vincula la cuenta IG a la página en Meta Business (Cuentas → Instagram)");
    } catch (err) {
      push("page_token", "Acceso de administración a la página", false, (err as Error).message, "Revisa que la página esté autorizada en la conexión");
    }

    // 3. Suscripción de la app a la página (EL eslabón que entrega los webhooks)
    if (pageToken) {
      try {
        const subs = await this.graph(`${encodeURIComponent(pageId)}/subscribed_apps`, pageToken);
        const mine = (subs.data ?? []).find((a: any) => String(a.id) === env.META_CRM_APP_ID);
        const fields: string[] = mine?.subscribed_fields ?? [];
        push(
          "subscribed",
          "App suscrita a la página",
          Boolean(mine),
          mine ? `Suscrita con campos: ${fields.join(", ") || "(ninguno)"}` : "La app CRM NO está suscrita a esta página",
          mine ? undefined : "Aprieta «Conectar» sobre la página en esta pantalla",
        );
        if (mine) {
          const missing = ["leadgen", "messages"].filter((f) => !fields.includes(f));
          push(
            "fields",
            "Campos leadgen + messages suscritos",
            missing.length === 0,
            missing.length ? `Faltan campos: ${missing.join(", ")}` : "leadgen y messages activos",
            missing.length ? "Re-conecta la página (el token debe traer pages_messaging para suscribir messages)" : undefined,
          );
        }
      } catch (err) {
        push("subscribed", "App suscrita a la página", false, (err as Error).message);
      }
    }

    // 4. Ruteo interno: assets registrados (webhook → tenant)
    const assets = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.metaAsset.findMany({ where: { OR: [{ kind: "page", externalId: pageId }, ...(igId ? [{ kind: "instagram", externalId: igId }] : [])] } }),
    );
    push("route_page", "Ruteo de la página al tenant", assets.some((a) => a.kind === "page"), assets.some((a) => a.kind === "page") ? "Página registrada" : "Página sin registrar en la plataforma", assets.some((a) => a.kind === "page") ? undefined : "Aprieta «Conectar» sobre la página");
    if (igId) {
      const igOk = assets.some((a) => a.kind === "instagram");
      push("route_ig", "Ruteo de Instagram al tenant", igOk, igOk ? "Cuenta IG registrada" : "Cuenta IG sin registrar", igOk ? undefined : "Re-conecta la página (registra el IG automáticamente)");
    }

    // 5. Ejercicio REAL de cada permiso (además de diagnosticar, estas llamadas
    // cuentan para Meta como "uso de la API" — requisito para poder solicitar
    // acceso avanzado en la App Review).
    if (pageToken) {
      try {
        const conv = await this.graph("me/conversations?limit=1", pageToken);
        push("pages_messaging", "Bandeja de Messenger accesible (pages_messaging)", true, `${(conv.data ?? []).length ? "Conversaciones visibles" : "Sin conversaciones aún (OK)"}`);
      } catch (err) {
        push("pages_messaging", "Bandeja de Messenger accesible (pages_messaging)", false, (err as Error).message);
      }
      try {
        const forms = await this.graph("me/leadgen_forms?limit=1", pageToken);
        push("pages_manage_ads", "Formularios de Lead Ads accesibles (pages_manage_ads)", true, `${(forms.data ?? []).length ? "Formularios visibles" : "Sin formularios (OK)"}`);
      } catch (err) {
        push("pages_manage_ads", "Formularios de Lead Ads accesibles (pages_manage_ads)", false, (err as Error).message);
      }
      if (igId) {
        try {
          const ig = await this.graph(`${igId}?fields=username`, pageToken);
          push("instagram_basic", "Perfil de Instagram accesible (instagram_basic)", true, `@${ig.username ?? igId}`);
        } catch (err) {
          push("instagram_basic", "Perfil de Instagram accesible (instagram_basic)", false, (err as Error).message);
        }
        try {
          const media = await this.graph(`${igId}/media?limit=1`, pageToken);
          const mediaId = media.data?.[0]?.id;
          if (mediaId) {
            const comments = await this.graph(`${mediaId}/comments?limit=1`, pageToken);
            push("instagram_manage_comments", "Comentarios de IG accesibles (instagram_manage_comments)", true, `${(comments.data ?? []).length ? "Comentarios visibles" : "Sin comentarios (OK)"}`);
          } else {
            push("instagram_manage_comments", "Comentarios de IG accesibles (instagram_manage_comments)", true, "La cuenta no tiene publicaciones aún (no se pudo ejercitar)");
          }
        } catch (err) {
          push("instagram_manage_comments", "Comentarios de IG accesibles (instagram_manage_comments)", false, (err as Error).message);
        }
      }
    }

    // 6. Recordatorio no-verificable por API
    push(
      "ig_toggle",
      "Acceso a mensajes en la app de Instagram (manual)",
      true,
      "Meta no expone este ajuste por API: en la app de IG (cuenta profesional) → Configuración → Mensajes → Herramientas conectadas → «Permitir acceso a los mensajes». Suele venir activado.",
    );

    return { checks };
  }
}

/**
 * Callback PÚBLICO del OAuth de Meta CRM (fuera del prefijo del controller de
 * arriba para caer bajo /public, exento de JWT — el state firmado es la auth).
 */
@Controller("public/oauth/meta-crm")
export class MetaCrmOauthCallbackController {
  constructor(private prisma: PrismaService) {}

  private async graph(path: string, token: string): Promise<any> {
    const v = getEnv().META_GRAPH_VERSION;
    const res = await fetchGraphWithProof(
      `https://graph.facebook.com/${v}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      token,
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `Graph ${res.status}`);
    return json;
  }

  @Get("callback")
  async callback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Res() res: Response) {
    const env = getEnv();
    const back = (q: string) => res.redirect(`${env.WEB_URL}/integrations/meta-crm?${q}`);
    const orgId = verifyState(state ?? "");
    if (!orgId) return back("oauth=invalid");
    if (!code) return back("oauth=denied");
    try {
      const v = env.META_GRAPH_VERSION;
      const redirectUri = `${env.API_URL}/public/oauth/meta-crm/callback`;
      const tokenRes = await fetch(
        `https://graph.facebook.com/${v}/oauth/access_token?client_id=${env.META_CRM_APP_ID}&client_secret=${encodeURIComponent(env.META_CRM_APP_SECRET)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`,
      );
      const tokenJson: any = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenJson.access_token) throw new Error(tokenJson?.error?.message ?? "sin access_token");
      // Token de larga duración (los tokens de integración de negocio duran 60 d o no expiran)
      const longRes = await fetch(
        `https://graph.facebook.com/${v}/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.META_CRM_APP_ID}&client_secret=${encodeURIComponent(env.META_CRM_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(tokenJson.access_token)}`,
      );
      const longJson: any = await longRes.json().catch(() => ({}));
      const accessToken: string = longJson.access_token ?? tokenJson.access_token;

      const [me, perms] = await Promise.all([
        this.graph("me?fields=name", accessToken).catch(() => ({})),
        this.graph("me/permissions", accessToken).catch(() => ({ data: [] })),
      ]);
      const scopes: string[] = (perms.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
      if (REQUIRED_SCOPES.some((s) => !scopes.includes(s))) return back("oauth=permisos");

      await this.prisma.withTenant(orgId, async (tx) => {
        const credential = await tx.integrationCredential.create({
          data: { organizationId: orgId, provider: "meta_crm", label: "OAuth Meta CRM (Conectar con Meta)", ciphertext: encryptSecret(accessToken) },
        });
        await tx.metaCrmConnection.upsert({
          where: { organizationId: orgId },
          update: { status: "CONNECTED", mode: "OAUTH", businessName: me.name ?? "Cuenta Meta", appScopes: scopes, credentialId: credential.id, lastError: null },
          create: { organizationId: orgId, status: "CONNECTED", mode: "OAUTH", businessName: me.name ?? "Cuenta Meta", appScopes: scopes, credentialId: credential.id },
        });
        await tx.integrationEvent.create({
          data: { organizationId: orgId, provider: "meta_crm", type: "connection.oauth", status: "ok", message: `Meta CRM conectado con OAuth (${scopes.length} permisos)` },
        });
      });
      return back("oauth=connected");
    } catch (err) {
      console.error("✖ OAuth Meta CRM:", (err as Error).message);
      return back("oauth=error");
    }
  }
}
