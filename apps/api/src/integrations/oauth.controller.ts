import { BadRequestException, Body, Controller, Delete, Get, Post, Put, Query, Res } from "@nestjs/common";
import { z } from "zod";
import type { Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { requirePermission } from "../tenancy/permissions";

/**
 * Framework OAuth por tenant (Google y HubSpot). Las credenciales de la APP
 * viven a nivel plataforma (env; ver docs/GUIA_OAUTH_GOOGLE.md y
 * GUIA_OAUTH_HUBSPOT.md). Los tokens del tenant van CIFRADOS como credencial
 * de integration_connections. El state va firmado (HMAC del JWT_SECRET) con
 * vencimiento de 10 minutos — anti CSRF.
 */

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/spreadsheets"];
export const HUBSPOT_SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write"];

function signState(orgId: string): string {
  const ts = String(Math.floor(Date.now() / 1000));
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

/** Tokens OAuth cifrados de una conexión. */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string | null;
  expiry: number; // epoch ms
}

@Controller()
export class OAuthController {
  constructor(private prisma: PrismaService) {}

  // ------------------------------- Google -------------------------------

  /** URL de autorización (el navegador del tenant la abre en una pestaña). */
  @Get("integrations/oauth/google/authorize")
  googleAuthorize() {
    const ctx = requirePermission("integrations:write");
    const env = getEnv();
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new BadRequestException("Configuración de plataforma pendiente: faltan GOOGLE_OAUTH_CLIENT_ID/SECRET (ver docs/GUIA_OAUTH_GOOGLE.md)");
    }
    const params = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: googleRedirectUri(),
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent", // fuerza refresh_token también en reconexiones
      state: signState(ctx.organizationId),
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  }

  /** Callback público (Google redirige el navegador; no hay JWT). */
  @Get("public/oauth/google/callback")
  async googleCallback(@Query("code") code: string, @Query("state") state: string, @Query("error") error: string, @Res() res: Response) {
    const env = getEnv();
    const back = (q: string) => res.redirect(302, `${env.WEB_URL}/integrations?google=${q}`);
    if (error) return back("denied");
    const orgId = verifyState(state ?? "");
    if (!orgId || !code) return back("invalid");
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
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
      }, { scopes: GOOGLE_SCOPES });
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
      await tx.integrationConnection.deleteMany({ where: { provider: "google" } });
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

  /** Configuración del espejo de citas (calendario destino + on/off). */
  @Put("integrations/google/config")
  async googleConfig(@Body() body: unknown) {
    const ctx = requirePermission("integrations:write");
    const parsed = z
      .object({ calendarId: z.string().max(300).optional(), calendarSync: z.boolean().optional() })
      .parse(body ?? {});
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider: "google" } });
      if (!conn) throw new BadRequestException("Conecta tu cuenta de Google primero");
      const config = { ...((conn.config as object) ?? {}), ...parsed } as object;
      await tx.integrationConnection.update({ where: { id: conn.id }, data: { config } });
      return { ok: true, config: parsed };
    });
  }

  /** Prueba real: lista calendarios (valida token + refresh) y reporta. */
  @Post("integrations/google/test")
  async googleTest() {
    const ctx = requirePermission("integrations:write");
    try {
      const { calendars } = await this.googleCalendars();
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.integrationConnection.updateMany({ where: { provider: "google" }, data: { lastSyncAt: new Date(), lastError: null, status: "active" } });
        await tx.integrationEvent.create({
          data: { organizationId: ctx.organizationId, provider: "google", type: "google.test", status: "ok", message: `Prueba OK: ${calendars.length} calendario(s) visibles` },
        });
      });
      return { ok: true, detail: `✔ Conexión activa · ${calendars.length} calendario(s) con permiso de escritura` };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        await tx.integrationConnection.updateMany({ where: { provider: "google" }, data: { lastError: message } });
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
    const back = (q: string) => res.redirect(302, `${env.WEB_URL}/integrations?hubspot=${q}`);
    const orgId = verifyState(state ?? "");
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
      return back("connected");
    } catch {
      return back("error");
    }
  }

  @Delete("integrations/hubspot")
  hubspotDisconnect() {
    const ctx = requirePermission("integrations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.integrationConnection.deleteMany({ where: { provider: "hubspot" } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.hubspot_disconnect", entityType: "integration_connection" },
      });
      return { ok: true };
    });
  }

  // ------------------------------- Helpers -------------------------------

  private async storeTokens(orgId: string, provider: "google" | "hubspot", tokens: OAuthTokens, extra: Record<string, unknown>) {
    await this.prisma.withTenant(orgId, async (tx) => {
      const existing = await tx.integrationConnection.findUnique({
        where: { organizationId_provider: { organizationId: orgId, provider } },
      });
      // Conservar el refresh_token anterior si Google no reenvía uno nuevo.
      if (!tokens.refresh_token && existing?.credentialId) {
        const prev = await tx.integrationCredential.findUnique({ where: { id: existing.credentialId } });
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
      const config = { ...((existing?.config as object) ?? {}), ...extra } as object;
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

  /** Access token vigente (refresca si vence en <60 s); marca "reauthorize" si el refresh falla. */
  async freshToken(orgId: string, provider: "google" | "hubspot"): Promise<string> {
    const env = getEnv();
    const stored = await this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider } });
      if (!conn?.credentialId) return null;
      const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
      if (!cred) return null;
      try {
        return { connId: conn.id, credId: cred.id, tokens: JSON.parse(decryptSecret(cred.ciphertext)) as OAuthTokens };
      } catch {
        return null;
      }
    });
    if (!stored) throw new BadRequestException(`La integración ${provider} no está conectada`);
    if (stored.tokens.expiry - Date.now() > 60_000) return stored.tokens.access_token;
    if (!stored.tokens.refresh_token) throw new BadRequestException("La sesión expiró: vuelve a conectar la cuenta");

    const ep =
      provider === "google"
        ? { url: "https://oauth2.googleapis.com/token", clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET }
        : { url: "https://api.hubapi.com/oauth/v1/token", clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET };
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.tokens.refresh_token,
        client_id: ep.clientId,
        client_secret: ep.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      await this.prisma.withTenant(orgId, (tx) =>
        tx.integrationConnection.updateMany({ where: { provider }, data: { status: "reauthorize", lastError: "El acceso fue revocado: vuelve a conectar la cuenta" } }),
      ).catch(() => undefined);
      throw new BadRequestException("El acceso fue revocado: vuelve a conectar la cuenta");
    }
    const next: OAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? stored.tokens.refresh_token,
      expiry: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    };
    await this.prisma.withTenant(orgId, async (tx) => {
      await tx.integrationCredential.update({ where: { id: stored.credId }, data: { ciphertext: encryptSecret(JSON.stringify(next)), rotatedAt: new Date() } });
      await tx.integrationConnection.update({ where: { id: stored.connId }, data: { status: "active", lastError: null } });
    });
    return next.access_token;
  }

  private async readTokens(orgId: string, provider: string): Promise<OAuthTokens | null> {
    return this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { provider } });
      if (!conn?.credentialId) return null;
      const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
      if (!cred) return null;
      try {
        return JSON.parse(decryptSecret(cred.ciphertext)) as OAuthTokens;
      } catch {
        return null;
      }
    });
  }
}
