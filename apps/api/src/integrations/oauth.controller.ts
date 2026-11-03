import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, Post, Put, Query, Res } from "@nestjs/common";
import { z } from "zod";
import type { Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getEnv,
  brandOf,
  canUseFeature,
  googleOAuthAppForBrand,
  googleOAuthAppOfConnection,
  googleOAuthCredentials,
  linkedCalendarIds,
  missingScopesForFeature,
  parseGoogleCalendarConfig,
  parseGrantedScopes,
  scopesForFeature,
  GOOGLE_CALENDAR_CONFIG_VACIA,
  type GoogleFeature,
  type GoogleOAuthApp,
} from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { requirePermission } from "../tenancy/permissions";
import { hasPermission } from "@conversia/types";
import { OAuthTokenService, type OAuthTokens } from "./oauth-token.service";
import { RateLimitService } from "../common/rate-limit";
import { GoogleBusyService } from "../scheduling/google-busy.service";

/**
 * Framework OAuth por tenant (Google y HubSpot). Las credenciales de la APP
 * viven a nivel plataforma (env; ver docs/GUIA_OAUTH_GOOGLE.md y
 * GUIA_OAUTH_HUBSPOT.md). Los tokens del tenant van CIFRADOS como credencial
 * de integration_connections. El state va firmado (HMAC del JWT_SECRET) con
 * vencimiento de 10 minutos — anti CSRF.
 */

export const HUBSPOT_SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write"];

export function signState(orgId: string, ts = String(Math.floor(Date.now() / 1000))): string {
  const sig = createHmac("sha256", getEnv().JWT_SECRET).update(`${orgId}.${ts}`).digest("hex");
  return Buffer.from(`${orgId}.${ts}.${sig}`).toString("base64url");
}

export function verifyState(state: string): string | null {
  try {
    const [orgId, ts, sig] = Buffer.from(state, "base64url").toString("utf8").split(".");
    if (!orgId || !ts || !sig) return null;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return null; // 10 min
    const expected = createHmac("sha256", getEnv().JWT_SECRET).update(`${orgId}.${ts}`).digest("hex");
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    return orgId;
  } catch {
    return null;
  }
}

function googleRedirectUri(): string {
  return `${getEnv().API_URL}/public/oauth/google/callback`;
}
function hubspotRedirectUri(): string {
  return `${getEnv().API_URL}/public/oauth/hubspot/callback`;
}

/**
 * Página final del popup OAuth: avisa al panel (postMessage al opener) y se
 * cierra sola. Si no hay opener (flujo en la misma pestaña o popup bloqueado),
 * cae al redirect clásico a /integrations?provider=resultado.
 */
function oauthResultPage(provider: "google" | "hubspot", result: "connected" | "denied" | "invalid" | "error", webUrl: string, brandName: string): string {
  // F1/A3 — webUrl y nombre POR MARCA del tenant (no el panel/título de TuBot): el popup
  // debe volver/postear al panel correcto o la integración no notifica al panel de Conversia.
  const target = `${webUrl}/integrations?${provider}=${result}`;
  const label = provider === "google" ? "Google" : "HubSpot";
  const message =
    result === "connected"
      ? `✅ Cuenta de ${label} conectada. Esta ventana se cerrará sola…`
      : result === "denied"
        ? `La conexión con ${label} fue cancelada. Puedes cerrar esta ventana.`
        : `No se pudo completar la conexión con ${label}. Puedes cerrar esta ventana e intentarlo de nuevo.`;
  // provider/result vienen de valores fijos del servidor (no input del usuario).
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${brandName}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#0f172a">
<p style="max-width:26rem;text-align:center;font-size:15px">${message}</p>
<script>
(function () {
  var payload = { source: "conversia-oauth", provider: "${provider}", result: "${result}" };
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, "${target.replace(/\/integrations.*$/, "")}");
      setTimeout(function () { window.close(); }, 800);
      return;
    }
  } catch (e) { /* opener inaccesible */ }
  window.location.replace("${target}");
})();
</script>
</body></html>`;
}

@Controller()
export class OAuthController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
    private tokens: OAuthTokenService,
    private rateLimit: RateLimitService,
    private googleBusy: GoogleBusyService,
  ) {}

  // ------------------------------- Google -------------------------------

  /**
   * URL de autorización (el navegador del tenant la abre en un popup).
   *
   * `feature` decide QUÉ permisos se piden: `calendar` (por defecto) pide solo los de
   * Calendar, `sheets` pide solo `spreadsheets`. Antes se pedían los tres juntos y el
   * cliente veía en la pantalla de Google que la app quería entrar a sus planillas.
   *
   * `include_granted_scopes` (autorización incremental) se manda cuando ya hay conexión o
   * cuando se suma Sheets: así el token nuevo conserva los permisos que ya estaban y
   * conectar Sheets no deja a Calendar sin permiso.
   */
  @Get("integrations/oauth/google/authorize")
  async googleAuthorize(@Query("feature") feature?: string) {
    const ctx = requirePermission("integrations:write");
    const env = getEnv();
    const parsed = z.enum(["calendar", "sheets"]).default("calendar").safeParse(feature ?? "calendar");
    if (!parsed.success) throw new BadRequestException("Función inválida (calendar | sheets)");
    const which: GoogleFeature = parsed.data;

    const { app, hasConnection } = await this.googleAppFor(ctx.organizationId);
    const creds = googleOAuthCredentials(app, env);
    if (creds.missing) {
      throw new BadRequestException(
        app === "conversia"
          ? "Configuración de plataforma pendiente: faltan GOOGLE_OAUTH_CONVERSIA_CLIENT_ID/SECRET (ver docs/GUIA_OAUTH_GOOGLE.md)"
          : "Configuración de plataforma pendiente: faltan GOOGLE_OAUTH_CLIENT_ID/SECRET (ver docs/GUIA_OAUTH_GOOGLE.md)",
      );
    }
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: googleRedirectUri(),
      response_type: "code",
      scope: scopesForFeature(which).join(" "),
      access_type: "offline",
      prompt: "consent", // fuerza refresh_token también en reconexiones
      state: signState(ctx.organizationId),
    });
    if (which === "sheets" || hasConnection) params.set("include_granted_scopes", "true");
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, feature: which, app };
  }

  /**
   * Qué app de Google corresponde a esta org. Si YA hay conexión manda la app con la que se
   * emitió el token (una conexión vieja no tiene `oauthApp` → la de siempre): refrescar con
   * credenciales distintas de las que emitieron el token falla, y eso rompería a los tenants
   * que ya están andando.
   */
  private async googleAppFor(orgId: string): Promise<{ app: GoogleOAuthApp; hasConnection: boolean }> {
    const env = getEnv();
    const conn = await this.prisma.withTenant(orgId, (tx) => tx.integrationConnection.findFirst({ where: { organizationId: orgId, provider: "google" } }));
    if (conn) return { app: googleOAuthAppOfConnection(conn.config), hasConnection: true };
    const org = await this.prisma.admin.organization.findUnique({ where: { id: orgId }, select: { brand: true } });
    return { app: googleOAuthAppForBrand(org?.brand, env), hasConnection: false };
  }

  /** Callback público (Google redirige el navegador; no hay JWT). */
  @Get("public/oauth/google/callback")
  async googleCallback(@Query("code") code: string, @Query("state") state: string, @Query("error") error: string, @Res() res: Response) {
    const env = getEnv();
    const orgId = verifyState(state ?? "");
    const brand = brandOf(orgId ? await this.prisma.admin.organization.findUnique({ where: { id: orgId }, select: { brand: true } }) : null);
    const back = (q: "connected" | "denied" | "invalid" | "error") => res.status(200).type("html").send(oauthResultPage("google", q, brand.webUrl, brand.name));
    if (error) return back("denied");
    if (!orgId || !code) return back("invalid");
    try {
      // Las MISMAS credenciales que usó authorize: canjear el código con otra app da
      // invalid_grant. La elección es determinista (conexión existente → su app; si no, la
      // marca), así que acá se recalcula sin necesidad de guardarla en el state.
      const { app } = await this.googleAppFor(orgId);
      const creds = googleOAuthCredentials(app, env);
      if (creds.missing) return back("error");
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: googleRedirectUri(),
          grant_type: "authorization_code",
        }),
      });
      const tokens: any = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) return back("error");
      await this.storeTokens(orgId, "google", {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expiry: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
        // Los permisos que Google OTORGÓ (no los que pedimos): el cliente puede desmarcar
        // alguno en la pantalla de permisos y hasta ahora guardábamos la lista pedida.
      }, { scopes: parseGrantedScopes(tokens.scope), oauthApp: app });
      // Con qué cuenta quedó conectado: el id del calendario primario ES el email.
      await this.captureAccount(orgId, "google", tokens.access_token).catch(() => undefined);
      return back("connected");
    } catch {
      return back("error");
    }
  }

  @Delete("integrations/google")
  async googleDisconnect() {
    const ctx = requirePermission("integrations:write");
    // Revocar el token en Google (best-effort) y borrar la conexión.
    const tokens = await this.readTokens(ctx.organizationId, "google");
    if (tokens?.refresh_token || tokens?.access_token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token ?? tokens.access_token)}`, { method: "POST" }).catch(() => undefined);
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.integrationConnection.deleteMany({ where: { organizationId: ctx.organizationId, provider: "google" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.google_disconnect", entityType: "integration_connection" },
      });
      return { ok: true };
    });
  }

  /** Calendarios visibles de la cuenta conectada (para el selector del drawer). */
  @Get("integrations/google/calendars")
  async googleCalendars() {
    const ctx = requirePermission("integrations:write");
    const token = await this.freshToken(ctx.organizationId, "google");
    const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BadRequestException(`Google respondió ${res.status} al listar calendarios`);
    const data: any = await res.json();
    return {
      calendars: ((data.items ?? []) as any[]).map((c) => ({ id: c.id, name: c.summary, primary: Boolean(c.primary) })),
    };
  }

  /**
   * Configuración del espejo de citas: calendario del NEGOCIO + interruptor + un calendario
   * POR PROFESIONAL (Etapa 1).
   *
   * Valida en el SERVIDOR las dos cosas que la UI no puede garantizar: que el profesional
   * sea de esta cuenta y que el calendario esté entre los que la cuenta conectada puede
   * escribir. Sin lo segundo se podía guardar el calendario de cualquiera —incluido uno de
   * otra empresa— y el error recién aparecía después, en el worker, como un 403 suelto.
   */
  @Put("integrations/google/config")
  async googleConfig(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const parsed = z
      .object({
        calendarId: z.string().max(300).optional(),
        calendarSync: z.boolean().optional(),
        calendarReadBusy: z.boolean().optional(),
        calendars: z
          .record(
            z.object({
              calendarId: z.string().max(300),
              readBusy: z.boolean().optional(),
              writeEvents: z.boolean().optional(),
            }),
          )
          .refine((o) => Object.keys(o).length <= 50, "Demasiados calendarios")
          .optional(),
      })
      .safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const datos = parsed.data;

    // Un calendarId vacío significa "desvincular": se quita la fila en vez de guardar basura.
    const entradas = Object.entries(datos.calendars ?? {}).filter(([, v]) => v.calendarId.trim().length > 0);
    const quitados = Object.keys(datos.calendars ?? {}).length - entradas.length;

    // 1) Los profesionales tienen que ser de ESTA cuenta (nunca confiar en el id del cliente).
    if (datos.calendars) {
      const ids = Object.keys(datos.calendars);
      const propios = await this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.professional.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      );
      const ajenos = ids.filter((id) => !propios.some((p) => p.id === id));
      if (ajenos.length) throw new BadRequestException("Hay profesionales que no son de esta cuenta");
    }

    // 2) Cada calendario tiene que estar entre los que la cuenta conectada puede ESCRIBIR.
    const aValidar = [...new Set([...(datos.calendarId?.trim() ? [datos.calendarId.trim()] : []), ...entradas.map(([, v]) => v.calendarId.trim())])];
    if (aValidar.length) {
      const { calendars: disponibles } = await this.googleCalendars();
      const faltan = aValidar.filter((id) => !disponibles.some((c) => c.id === id));
      if (faltan.length) {
        throw new BadRequestException(
          `La cuenta conectada no puede escribir en ${faltan.join(", ")}. Pide que compartan ese calendario con permiso "Hacer cambios en eventos" y vuelve a intentar.`,
        );
      }
    }

    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, provider: "google" } });
      if (!conn) throw new BadRequestException("Conecta tu cuenta de Google primero");
      const previo = (conn.config as Record<string, unknown> | null) ?? {};
      const config: Record<string, unknown> = { ...previo };
      if (datos.calendarId !== undefined) config.calendarId = datos.calendarId.trim();
      if (datos.calendarSync !== undefined) config.calendarSync = datos.calendarSync;
      if (datos.calendarReadBusy !== undefined) config.calendarReadBusy = datos.calendarReadBusy;
      // Solo se reemplaza el mapa si vino en el body: un PUT parcial (apagar el espejo, p. ej.)
      // no puede borrar los calendarios ya vinculados.
      if (datos.calendars !== undefined) {
        config.calendars = Object.fromEntries(
          entradas.map(([proId, v]) => [proId, { calendarId: v.calendarId.trim(), readBusy: v.readBusy !== false, writeEvents: v.writeEvents !== false }]),
        );
      }
      await tx.integrationConnection.update({ where: { id: conn.id }, data: { config: config as object } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "integration.google_calendars",
          entityType: "integration_connection",
          entityId: conn.id,
          after: { calendarSync: config.calendarSync ?? null, vinculados: Object.keys((config.calendars as object) ?? {}).length, desvinculados: quitados } as object,
        },
      });
      return { ok: true, config: parseGoogleCalendarConfig(config) };
    });
  }

  /**
   * Estado de Google para la pantalla de Agenda (Etapa 1).
   *
   * Existe porque el panel de Conversia NO tiene pantalla de Integraciones: la configuración
   * de calendarios vive en la Agenda, y necesita en UNA llamada el estado de la conexión, la
   * config vigente, los profesionales y los calendarios disponibles. El overview de
   * integraciones trae media plataforma y es de otro panel.
   */
  @Get("integrations/google/status")
  async googleStatus() {
    const ctx = requirePermission("integrations:read");
    const env = getEnv();
    const { conn, professionals } = await this.prisma.withTenant(ctx.organizationId, async (tx) => ({
      conn: await tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, provider: "google" } }),
      professionals: await tx.professional.findMany({ where: { active: true }, select: { id: true, name: true, specialty: true }, orderBy: { name: "asc" } }),
    }));
    const { app } = await this.googleAppFor(ctx.organizationId);
    const plataformaLista = !googleOAuthCredentials(app, env).missing;
    const puedeConfigurar = hasPermission(ctx.permissions, "integrations:write");

    if (!conn) {
      return { connected: false, plataformaLista, puedeConfigurar, app, professionals, config: GOOGLE_CALENDAR_CONFIG_VACIA, calendarOptions: null, permisos: null, status: null, lastError: null, accountEmail: null, lastSyncAt: null };
    }
    const cfg = parseGoogleCalendarConfig(conn.config);
    // La lista de calendarios es una llamada a Google: si falla (token revocado, caída) NO se
    // cae toda la pantalla — se muestra la config guardada y el error.
    let calendarOptions: Array<{ id: string; name: string; primary: boolean }> | null = null;
    let listError: string | null = null;
    try {
      calendarOptions = (await this.googleCalendars()).calendars;
    } catch (err) {
      listError = (err as Error).message;
    }
    return {
      connected: true,
      plataformaLista,
      // Quien no puede configurar integraciones ve el ESTADO pero no las acciones (los
      // endpoints ya lo bloquean; esto evita ofrecerle un botón que le va a dar 403).
      puedeConfigurar,
      app,
      professionals,
      config: cfg,
      calendarOptions,
      permisos: { calendar: canUseFeature(conn.config, "calendar"), faltanParaCalendar: missingScopesForFeature(conn.config, "calendar") },
      status: conn.status,
      lastError: listError ?? conn.lastError,
      accountEmail: (conn.config as Record<string, unknown> | null)?.accountEmail ?? null,
      lastSyncAt: conn.lastSyncAt,
      // Resumen del último sondeo (lo escribe el worker): "3 cambios traídos de Google".
      lastPull: ((conn.config as Record<string, unknown> | null)?.lastPull as Record<string, unknown> | undefined) ?? null,
    };
  }

  /**
   * ETAPA 4 — "Activar sincronización": el ÚNICO botón del asistente de la Agenda.
   *
   * Guarda la configuración y, de una, sube a Google las citas FUTURAS que ya existen. Sin
   * esa carga inicial el dueño activa la sincronización, mira su calendario y no ve nada:
   * las citas de la semana que viene se quedarían afuera para siempre, porque el espejo solo
   * reacciona a cambios NUEVOS.
   *
   * No duplica: una cita que ya tiene `googleEventId` se actualiza (el espejo hace PATCH).
   */
  @Post("integrations/google/activate")
  async googleActivate(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    // Reutiliza la validación del PUT (profesional de la cuenta + calendario con permiso de
    // escritura): es la MISMA regla y no puede divergir.
    await this.googleConfig({ ...(body as object), calendarSync: true });

    const futuras = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.appointment.findMany({
        where: { startsAt: { gte: new Date() }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
        select: { id: true },
        orderBy: { startsAt: "asc" },
        take: 500,
      }),
    );
    if (futuras.length) {
      // Escalonado para no golpear la cuota de Google con 500 escrituras de golpe.
      await this.queues.sync.addBulk(
        futuras.map((a, i) => ({
          name: "calendar",
          data: { organizationId: ctx.organizationId, kind: "calendar_sync" as const, payload: { appointmentId: a.id, action: "upsert" as const } },
          opts: { delay: i * 300, attempts: 5, backoff: { type: "exponential" as const, delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
        })),
      );
    }
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "google", type: "calendar.activated", status: "ok", message: `Sincronización activada · ${futuras.length} cita(s) futura(s) enviadas` },
      }),
    ).catch(() => undefined);
    return { ok: true, citasEnviadas: futuras.length };
  }

  /**
   * ETAPA 4 — "sincronizar ahora": adelanta lo que ya corre solo.
   *
   * La sincronización automática (sondeo cada 5 min + espejo por cada cita) no cambia; esto
   * solo la apura cuando el dueño no quiere esperar. Hace tres cosas: borra la caché de horas
   * ocupadas, encola el sondeo de cambios y reintenta las citas que quedaron sin espejar.
   *
   * Límite de 1 por minuto y por cuenta: el botón invita a apretarlo varias veces, y cada
   * apretón son llamadas pagas a Google.
   */
  @Post("integrations/google/sync-now")
  async googleSyncNow() {
    const ctx = requirePermission("integrations:write");
    const rl = await this.rateLimit.custom(`rl:gcal:sync-now:${ctx.organizationId}`, 1, 60);
    if (!rl.allowed) throw new HttpException("Recién sincronizamos. Espera un momento antes de volver a intentar.", HttpStatus.TOO_MANY_REQUESTS);

    const conn = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, provider: "google" }, select: { config: true } }),
    );
    if (!conn) throw new BadRequestException("Conecta tu cuenta de Google primero");

    const borradas = await this.googleBusy.invalidate(ctx.organizationId);
    // El sondeo corre en el worker (es quien tiene el token y la lógica): se encola y el
    // panel lee el resumen de `lastPull` al refrescar el estado.
    await this.queues.sync.add(
      "calendar_pull",
      { organizationId: ctx.organizationId, kind: "calendar_pull" as const, payload: {} },
      { attempts: 2, removeOnComplete: 50, removeOnFail: 100 },
    );

    // Reintento de lo que quedó sin espejar: citas futuras sin evento en Google, o marcadas
    // para revisar. No se re-envía todo: eso gastaría cuota por nada.
    const pendientes = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.appointment.findMany({
        where: { startsAt: { gte: new Date() }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
        select: { id: true, meta: true },
        orderBy: { startsAt: "asc" },
        take: 300,
      }),
    );
    const aEnviar = pendientes.filter((a) => {
      const m = (a.meta as Record<string, unknown> | null) ?? {};
      return !m.googleEventId || m.googleChange;
    });
    if (aEnviar.length) {
      await this.queues.sync.addBulk(
        aEnviar.map((a, i) => ({
          name: "calendar",
          data: { organizationId: ctx.organizationId, kind: "calendar_sync" as const, payload: { appointmentId: a.id, action: "upsert" as const } },
          opts: { delay: i * 300, attempts: 5, backoff: { type: "exponential" as const, delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
        })),
      );
    }
    return { ok: true, cacheBorrada: borradas, sondeoEncolado: true, citasEnviadas: aEnviar.length };
  }

  /**
   * "Probar": cuántos eventos tiene HOY cada calendario vinculado. Es la comprobación que le
   * dice al dueño "sí, estoy viendo el calendario correcto" sin mostrar los títulos de los
   * eventos personales (eso no nos corresponde mostrarlo en el panel).
   */
  @Post("integrations/google/calendars/test")
  async googleCalendarsTest() {
    const ctx = requirePermission("integrations:write");
    const conn = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, provider: "google" } }),
    );
    if (!conn) throw new BadRequestException("Conecta tu cuenta de Google primero");
    const cfg = parseGoogleCalendarConfig(conn.config);
    const ids = linkedCalendarIds(cfg);
    if (!ids.length) return { ok: false, detail: "Todavía no hay ningún calendario vinculado.", calendars: [] };

    const token = await this.freshToken(ctx.organizationId, "google");
    const desde = new Date();
    desde.setUTCHours(0, 0, 0, 0);
    const hasta = new Date(desde.getTime() + 24 * 3600 * 1000);
    const resultados = await Promise.all(
      ids.map(async (calendarId) => {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?singleEvents=true&timeMin=${desde.toISOString()}&timeMax=${hasta.toISOString()}&maxResults=50`;
        try {
          const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
          if (!res.ok) return { calendarId, ok: false, eventos: 0, detail: `Google respondió ${res.status}` };
          const data: any = await res.json();
          const eventos = ((data.items ?? []) as any[]).filter((e) => e.status !== "cancelled");
          const nuestros = eventos.filter((e) => e.extendedProperties?.private?.conversiaAppointmentId).length;
          return { calendarId, ok: true, eventos: eventos.length, nuestros, detail: null };
        } catch (err) {
          return { calendarId, ok: false, eventos: 0, detail: (err as Error).message?.slice(0, 120) ?? "error" };
        }
      }),
    );
    const fallidos = resultados.filter((r) => !r.ok);
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId: ctx.organizationId,
          provider: "google",
          type: "calendar.test",
          status: fallidos.length ? "error" : "ok",
          message: fallidos.length ? `Prueba de calendarios: ${fallidos.length} con error` : `Prueba de calendarios OK: ${resultados.length} calendario(s)`,
        },
      }),
    ).catch(() => undefined);
    return { ok: fallidos.length === 0, calendars: resultados };
  }

  /** Prueba real: lista calendarios (valida token + refresh) y reporta. */
  @Post("integrations/google/test")
  async googleTest() {
    const ctx = requirePermission("integrations:write");
    try {
      const { calendars } = await this.googleCalendars();
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.integrationConnection.updateMany({ where: { organizationId: ctx.organizationId, provider: "google" }, data: { lastSyncAt: new Date(), lastError: null, status: "active" } });
        await tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "google", type: "google.test", status: "ok", message: `Prueba OK: ${calendars.length} calendario(s) visibles` },
        });
      });
      return { ok: true, detail: `✔ Conexión activa · ${calendars.length} calendario(s) con permiso de escritura` };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.integrationConnection.updateMany({ where: { organizationId: ctx.organizationId, provider: "google" }, data: { lastError: message } });
        await tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "google", type: "google.test", status: "error", message },
        });
      }).catch(() => undefined);
      return { ok: false, detail: message };
    }
  }

  // ------------------------------- HubSpot -------------------------------

  @Get("integrations/oauth/hubspot/authorize")
  hubspotAuthorize() {
    const ctx = requirePermission("integrations:write");
    const env = getEnv();
    if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
      throw new BadRequestException("Configuración de plataforma pendiente: faltan HUBSPOT_CLIENT_ID/SECRET (ver docs/GUIA_OAUTH_HUBSPOT.md)");
    }
    const params = new URLSearchParams({
      client_id: env.HUBSPOT_CLIENT_ID,
      redirect_uri: hubspotRedirectUri(),
      scope: HUBSPOT_SCOPES.join(" "),
      state: signState(ctx.organizationId),
    });
    return { url: `https://app.hubspot.com/oauth/authorize?${params.toString()}` };
  }

  @Get("public/oauth/hubspot/callback")
  async hubspotCallback(@Query("code") code: string, @Query("state") state: string, @Res() res: Response) {
    const env = getEnv();
    const orgId = verifyState(state ?? "");
    const brand = brandOf(orgId ? await this.prisma.admin.organization.findUnique({ where: { id: orgId }, select: { brand: true } }) : null);
    const back = (q: "connected" | "denied" | "invalid" | "error") => res.status(200).type("html").send(oauthResultPage("hubspot", q, brand.webUrl, brand.name));
    if (!orgId || !code) return back("invalid");
    try {
      const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: env.HUBSPOT_CLIENT_ID,
          client_secret: env.HUBSPOT_CLIENT_SECRET,
          redirect_uri: hubspotRedirectUri(),
        }),
      });
      const tokens: any = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) return back("error");
      await this.storeTokens(orgId, "hubspot", {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expiry: Date.now() + Number(tokens.expires_in ?? 1800) * 1000,
      }, { scopes: HUBSPOT_SCOPES });
      await this.captureAccount(orgId, "hubspot", tokens.access_token).catch(() => undefined);
      return back("connected");
    } catch {
      return back("error");
    }
  }

  /** Prueba real: introspección del token → portal (hub) conectado. */
  @Post("integrations/hubspot/test")
  async hubspotTest() {
    const ctx = requirePermission("integrations:write");
    try {
      const token = await this.freshToken(ctx.organizationId, "hubspot");
      const res = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new BadRequestException(`HubSpot respondió ${res.status}`);
      const info: any = await res.json();
      const detail = `✔ Conectado al portal ${info.hub_domain ?? "?"} (hub #${info.hub_id ?? "?"}) como ${info.user ?? "?"}`;
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.integrationConnection.updateMany({ where: { organizationId: ctx.organizationId, provider: "hubspot" }, data: { lastSyncAt: new Date(), lastError: null, status: "active" } });
        await tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "hubspot", type: "hubspot.test", status: "ok", message: detail },
        });
      });
      return { ok: true, detail, portal: { domain: info.hub_domain ?? null, hubId: info.hub_id ?? null } };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "hubspot", type: "hubspot.test", status: "error", message },
        }),
      ).catch(() => undefined);
      return { ok: false, detail: message };
    }
  }

  /** Config de la sincronización: mapeo de campos + sync automático on/off. */
  @Put("integrations/hubspot/config")
  async hubspotConfig(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const parsed = z
      .object({
        syncAuto: z.boolean().optional(),
        fieldMapping: z.record(z.enum(["firstName", "lastName", "email", "phone", "country", "source"])).optional(),
      })
      .parse(body ?? {});
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, provider: "hubspot" } });
      if (!conn) throw new BadRequestException("Conecta tu cuenta de HubSpot primero");
      const config = { ...((conn.config as object) ?? {}), ...parsed } as object;
      await tx.integrationConnection.update({ where: { id: conn.id }, data: { config } });
      return { ok: true };
    });
  }

  /** Backfill: encola la sincronización de TODOS los contactos existentes (lotes con backoff). */
  @Post("integrations/hubspot/sync-all")
  async hubspotSyncAll() {
    const ctx = requirePermission("integrations:write");
    const contacts = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, provider: "hubspot" } });
      if (!conn) throw new BadRequestException("Conecta tu cuenta de HubSpot primero");
      return tx.contact.findMany({
        where: { deletedAt: null, OR: [{ phone: { not: null } }, { email: { not: null } }] },
        select: { id: true },
        take: 5000,
        orderBy: { createdAt: "asc" },
      });
    });
    // Escalonado (200 ms entre jobs) para respetar los límites de tasa de HubSpot.
    await this.queues.sync.addBulk(
      contacts.map((c, i) => ({
        name: "hubspot",
        data: { organizationId: ctx.organizationId, kind: "hubspot_contact" as const, payload: { contactId: c.id } },
        opts: { delay: i * 200, attempts: 5, backoff: { type: "exponential" as const, delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
      })),
    );
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId: ctx.organizationId, provider: "hubspot", type: "hubspot.backfill", status: "ok", message: `Backfill encolado: ${contacts.length} contacto(s)` },
      }),
    ).catch(() => undefined);
    return { ok: true, queued: contacts.length };
  }

  @Delete("integrations/hubspot")
  hubspotDisconnect() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.integrationConnection.deleteMany({ where: { organizationId: ctx.organizationId, provider: "hubspot" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.hubspot_disconnect", entityType: "integration_connection" },
      });
      return { ok: true };
    });
  }

  // ------------------------------- Helpers -------------------------------

  /** Guarda en config con qué cuenta quedó conectada la integración (best-effort). */
  private async captureAccount(orgId: string, provider: "google" | "hubspot", accessToken: string): Promise<void> {
    let patch: Record<string, string> | null = null;
    if (provider === "google") {
      // El id del calendario primario es el email de la cuenta (scope calendar.readonly ya otorgado).
      const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner", {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const data: any = await res.json();
        const primary = ((data.items ?? []) as any[]).find((c) => c.primary);
        if (primary?.id) patch = { accountEmail: String(primary.id) };
      }
    } else {
      const res = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const info: any = await res.json();
        patch = { ...(info.user ? { accountEmail: String(info.user) } : {}), ...(info.hub_domain ? { hubDomain: String(info.hub_domain) } : {}) };
      }
    }
    if (!patch || !Object.keys(patch).length) return;
    await this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { organizationId: orgId, provider } });
      if (!conn) return;
      await tx.integrationConnection.update({ where: { id: conn.id }, data: { config: { ...((conn.config as object) ?? {}), ...patch } as object } });
    });
  }

  private async storeTokens(orgId: string, provider: "google" | "hubspot", tokens: OAuthTokens, extra: Record<string, unknown>) {
    await this.prisma.withTenant(orgId, async (tx) => {
      const existing = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: orgId, provider } },
      });
      // Conservar el refresh_token anterior si Google no reenvía uno nuevo.
      if (!tokens.refresh_token && existing?.credentialId) {
        const prev = await tx.integrationCredential.findFirst({ where: { id: existing.credentialId, organizationId: orgId } });
        if (prev) {
          try {
            tokens.refresh_token = (JSON.parse(decryptSecret(prev.ciphertext)) as OAuthTokens).refresh_token;
          } catch {
            /* ignorar */
          }
        }
      }
      const credential = await tx.integrationCredential.create({
        data: { organizationId: orgId, provider, label: `OAuth ${provider}`, ciphertext: encryptSecret(JSON.stringify(tokens)) },
      });
      // Autorización incremental: conectar Sheets no puede BORRAR el permiso de Calendar de
      // la lista. Se unen los otorgados ahora con los que ya estaban guardados EXPLÍCITAMENTE
      // (no con los heredados que asume `grantedScopes`: eso afirmaría un permiso que el
      // cliente pudo haber quitado).
      const extraOut = { ...extra };
      if (Array.isArray(extra.scopes)) {
        const prev = (existing?.config as Record<string, unknown> | null)?.scopes;
        const before = Array.isArray(prev) ? prev.map((s) => String(s)) : [];
        extraOut.scopes = [...new Set([...before, ...(extra.scopes as unknown[]).map((s) => String(s))])];
      }
      const config = { ...((existing?.config as object) ?? {}), ...extraOut } as object;
      if (existing) {
        await tx.integrationConnection.update({
          where: { id: existing.id },
          data: { credentialId: credential.id, status: "active", lastError: null, config },
        });
      } else {
        await tx.integrationConnection.create({
          data: { organizationId: orgId, provider, credentialId: credential.id, config },
        });
      }
      await tx.integrationEvent.create({
        data: { organizationId: orgId, provider, type: `${provider}.connected`, status: "ok", message: `Cuenta de ${provider === "google" ? "Google" : "HubSpot"} conectada` },
      });
    });
  }

  /**
   * Access token vigente. La implementación vive en `OAuthTokenService` porque la Agenda
   * también necesita un token (horas ocupadas de Google) y un controlador no se inyecta.
   */
  async freshToken(orgId: string, provider: "google" | "hubspot"): Promise<string> {
    return this.tokens.freshToken(orgId, provider);
  }

  private async readTokens(orgId: string, provider: string): Promise<OAuthTokens | null> {
    return this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { organizationId: orgId, provider } });
      if (!conn?.credentialId) return null;
      const cred = await tx.integrationCredential.findFirst({ where: { id: conn.credentialId, organizationId: orgId } });
      if (!cred) return null;
      try {
        return JSON.parse(decryptSecret(cred.ciphertext)) as OAuthTokens;
      } catch {
        return null;
      }
    });
  }
}
