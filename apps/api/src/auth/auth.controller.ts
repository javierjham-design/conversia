import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import * as bcrypt from "bcryptjs";
import { z } from "zod";
import { getEnv, brandFromOrigin, ACCENTS } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";
import { requireContext } from "../tenancy/context";
import { verifyAppToken, verifyInviteToken, verifyMfaToken } from "./jwt";
import { resolvePersonalization } from "../common/industries";
import { AuthService } from "./auth.service";

const registerSchema = z.object({
  email: z.string().email().max(200),
  // Política por longitud (ASVS 2.1): mínimo 10, sin tope agresivo (permite passphrases)
  password: z.string().min(10, "La contraseña debe tener al menos 10 caracteres").max(200),
  name: z.string().min(2).max(80),
  organizationName: z.string().min(2).max(120),
  // País ISO-3166 alpha-2 (default CL) → deriva la moneda. NO se acepta `brand` del
  // body: la marca se deriva server-side del Origin (ver register()).
  country: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/, "País inválido (ISO-3166 alpha-2)")).default("CL"),
  // Rubro opcional (F2): si viene y hay paquete vertical activo, se instala al registrar.
  vertical: z.string().trim().min(2).max(40).optional(),
});

// La derivación de marca por Origin vive en @conversia/config (compartida con el super
// admin, D8). Se re-exporta aquí por compatibilidad con los imports/tests existentes.
export { brandFromOrigin };

/** Paleta curada de acentos de UI. Incluye los genéricos (TuBot) + los 6 curados de
 *  Conversia (Nocturna): el acento del usuario se persiste por marca sin romper TuBot. */
const ACCENT_PALETTE = ["indigo", "violet", "blue", "teal", "emerald", "amber", "rose", "slate", "menta", "artico", "lima", "oro", "coral"] as const;

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
}

@Controller("auth")
export class AuthController {
  constructor(
    private auth: AuthService,
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
  ) {}

  @Post("register")
  async register(@Body() body: unknown, @Req() req: Request) {
    const input = parse(registerSchema, body);
    const rl = await this.rateLimit.register(clientIp(req));
    if (!rl.allowed) {
      throw new HttpException("Demasiados registros desde este origen. Intenta más tarde.", HttpStatus.TOO_MANY_REQUESTS);
    }
    // La marca la fija el servidor por el Origin, no el body (no se puede forzar).
    const brand = brandFromOrigin(req.headers.origin as string | undefined);
    return this.auth.register({ ...input, brand });
  }

  /** Verificación de correo (D6): confirma el correo con el token del link (público). */
  @Post("verify-email")
  async verifyEmail(@Body() body: unknown) {
    const parsed = z.object({ token: z.string().min(10) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Token requerido");
    return this.auth.verifyEmail(parsed.data.token);
  }

  /** Reenvía el correo de verificación al usuario autenticado. */
  @Post("resend-verification")
  async resendVerification() {
    const ctx = requireContext();
    return this.auth.resendVerification(ctx.userId!);
  }

  @Post("login")
  async login(@Body() body: unknown, @Req() req: Request) {
    const input = parse(loginSchema, body);
    // Límite por EMAIL (credencial atacada, no spoofeable) — anti credential stuffing
    const rl = await this.rateLimit.login(input.email);
    if (!rl.allowed) {
      throw new HttpException(
        "Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // La cuenta se resuelve en la marca del dominio de origen (D8): mismo correo, cuentas distintas.
    const brand = brandFromOrigin(req.headers.origin as string | undefined);
    return this.auth.login({ ...input, brand });
  }

  // --------------------------- Invitaciones ---------------------------

  /** Datos del invitado a partir del token del link (público). */
  @Get("invite/:token")
  async inviteInfo(@Req() req: Request) {
    const token = (req.params as { token: string }).token;
    let claims: { sub: string; fresh: boolean };
    try {
      claims = verifyInviteToken(token);
    } catch {
      throw new BadRequestException("El enlace de invitación no es válido o expiró.");
    }
    const user = await this.prisma.admin.user.findUnique({
      where: { id: claims.sub },
      select: { email: true, name: true },
    });
    if (!user) throw new BadRequestException("La invitación ya no está disponible.");
    return { email: user.email, name: user.name, needsPassword: claims.fresh };
  }

  /** Acepta la invitación fijando la contraseña (público, solo para cuentas nuevas). */
  @Post("accept-invite")
  async acceptInvite(@Body() body: unknown, @Req() req: Request) {
    const input = parse(
      z.object({
        token: z.string().min(10),
        password: z.string().min(10, "La contraseña debe tener al menos 10 caracteres").max(200),
      }),
      body,
    );
    const rl = await this.rateLimit.register(clientIp(req));
    if (!rl.allowed) throw new HttpException("Demasiados intentos. Intenta más tarde.", HttpStatus.TOO_MANY_REQUESTS);
    let claims: { sub: string; fresh: boolean };
    try {
      claims = verifyInviteToken(input.token);
    } catch {
      throw new BadRequestException("El enlace de invitación no es válido o expiró.");
    }
    if (!claims.fresh) {
      throw new BadRequestException("Ya tienes una cuenta. Inicia sesión con tu contraseña.");
    }
    const user = await this.prisma.admin.user.findUnique({ where: { id: claims.sub } });
    if (!user) throw new BadRequestException("La invitación ya no está disponible.");
    // El link solo sirve para el primer ingreso: si la cuenta ya inició sesión,
    // no puede reusarse para resetear la contraseña.
    if (user.lastLoginAt) {
      throw new BadRequestException("Esta invitación ya fue usada. Inicia sesión con tu contraseña.");
    }
    await this.prisma.admin.user.update({
      where: { id: user.id },
      data: { passwordHash: bcrypt.hashSync(input.password, 12) },
    });
    return { ok: true, email: user.email };
  }

  // --------------------------- MFA (TOTP) ---------------------------
  // Rutas públicas (/auth/mfa): la identidad se resuelve por token explícito
  // (Bearer de sesión para autoservicio, o mfaToken corto para el 2.º factor /
  // enrolamiento forzado). Nunca dan acceso a la app por sí solas.

  /** Resuelve el usuario actor: sesión (Bearer) o mfaToken de propósito `setup`. */
  private actorId(req: Request, mfaToken?: string): string {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) {
      try {
        return verifyAppToken(h.slice(7)).sub;
      } catch {
        /* cae al mfaToken */
      }
    }
    if (mfaToken) {
      try {
        return verifyMfaToken(mfaToken, "setup").sub;
      } catch {
        /* no válido */
      }
    }
    throw new UnauthorizedException("No autenticado");
  }

  /** 2.º factor en el login: verifica el código y emite la sesión completa. */
  @Post("mfa/verify")
  async mfaVerify(@Body() body: unknown) {
    const input = parse(z.object({ mfaToken: z.string(), code: z.string().min(6).max(20) }), body);
    let userId: string;
    try {
      userId = verifyMfaToken(input.mfaToken, "verify").sub;
    } catch {
      throw new UnauthorizedException("La sesión de verificación expiró. Inicia sesión de nuevo.");
    }
    const rl = await this.rateLimit.login(`mfa:${userId}`);
    if (!rl.allowed) throw new HttpException("Demasiados intentos. Espera unos minutos.", HttpStatus.TOO_MANY_REQUESTS);
    return this.auth.verifyMfaLogin(userId, input.code.trim());
  }

  /** Genera el secreto TOTP y devuelve el URI para el QR (autoservicio o forzado). */
  @Post("mfa/setup")
  async mfaSetup(@Req() req: Request, @Body() body: unknown) {
    const input = parse(z.object({ mfaToken: z.string().optional() }), body ?? {});
    return this.auth.beginMfaSetup(this.actorId(req, input.mfaToken));
  }

  /** Confirma el código, activa MFA y devuelve los códigos de recuperación (una vez) + sesión. */
  @Post("mfa/enable")
  async mfaEnable(@Req() req: Request, @Body() body: unknown) {
    const input = parse(z.object({ code: z.string().min(6).max(10), mfaToken: z.string().optional() }), body);
    return this.auth.enableMfa(this.actorId(req, input.mfaToken), input.code.trim());
  }

  /** Desactiva MFA (requiere sesión + un código válido). */
  @Post("mfa/disable")
  async mfaDisable(@Req() req: Request, @Body() body: unknown) {
    const input = parse(z.object({ code: z.string().min(6).max(20) }), body);
    return this.auth.disableMfa(this.actorId(req), input.code.trim());
  }

  /** Estado MFA del usuario + si la organización lo exige a admins. */
  @Get("mfa/status")
  async mfaStatus(@Req() req: Request) {
    const claims = this.claimsFromBearer(req);
    const [user, org] = await Promise.all([
      this.prisma.admin.user.findUnique({ where: { id: claims.sub }, select: { mfaEnabled: true } }),
      this.prisma.admin.organization.findUnique({ where: { id: claims.orgId }, select: { settings: true } }),
    ]);
    return {
      enabled: user?.mfaEnabled ?? false,
      role: claims.role,
      requireMfaForAdmins: (org?.settings as any)?.security?.requireMfaForAdmins === true,
    };
  }

  /** Owner: exigir MFA a owner/admin de la organización (org.settings.security). */
  @Post("mfa/org-require")
  async mfaOrgRequire(@Req() req: Request, @Body() body: unknown) {
    const claims = this.claimsFromBearer(req);
    if (claims.role !== "owner") throw new UnauthorizedException("Solo el propietario puede cambiar esta política.");
    const input = parse(z.object({ enabled: z.boolean() }), body);
    const org = await this.prisma.admin.organization.findUnique({ where: { id: claims.orgId }, select: { settings: true } });
    const settings = { ...((org?.settings as Record<string, any>) ?? {}) };
    settings.security = { ...(settings.security ?? {}), requireMfaForAdmins: input.enabled };
    await this.prisma.admin.organization.update({ where: { id: claims.orgId }, data: { settings: settings as object } });
    return { ok: true, requireMfaForAdmins: input.enabled };
  }

  private claimsFromBearer(req: Request) {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new UnauthorizedException("No autenticado");
    try {
      return verifyAppToken(h.slice(7));
    } catch {
      throw new UnauthorizedException("Token inválido o expirado");
    }
  }

  /** Config pública para el botón de Google en el login (client id no es secreto). */
  @Get("google-config")
  googleConfig() {
    return { clientId: getEnv().GOOGLE_CLIENT_ID };
  }

  /** Login con Google: valida el ID token con Google y emite nuestro JWT. */
  @Post("google")
  async google(@Body() body: unknown, @Req() req: Request) {
    const { credential } = parse(z.object({ credential: z.string().min(10) }), body);
    const env = getEnv();
    if (!env.GOOGLE_CLIENT_ID) throw new BadRequestException("El inicio con Google no está configurado.");
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
    );
    const info: any = await res.json().catch(() => ({}));
    const emailVerified = info?.email_verified === true || info?.email_verified === "true";
    if (!res.ok || info?.aud !== env.GOOGLE_CLIENT_ID || !info?.email || !emailVerified) {
      throw new UnauthorizedException("No se pudo validar tu cuenta de Google.");
    }
    // D8 — la cuenta de Google se resuelve dentro de la marca del Origin (TuBot vs Conversia).
    const brand = brandFromOrigin(req.headers.origin as string | undefined);
    return this.auth.loginWithGoogle(String(info.email).toLowerCase(), brand);
  }

  /** Organizaciones del usuario actual + cuál está activa (selector de tenant). */
  @Get("organizations")
  async organizations() {
    const ctx = requireContext();
    const organizations = await this.auth.listOrganizations(ctx.userId!);
    return { organizations, current: ctx.organizationId };
  }

  /** Cambia la organización activa y devuelve un token nuevo para ese tenant. */
  @Post("switch")
  async switch(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ organizationId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("organizationId requerido");
    return this.auth.switchOrg(ctx.userId!, parsed.data.organizationId);
  }

  @Get("me")
  async me() {
    const ctx = requireContext();
    const [user, org] = await Promise.all([
      this.prisma.admin.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, email: true, name: true, mfaEnabled: true, emailVerifiedAt: true, settings: true },
      }),
      this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.organization.findUnique({
          where: { id: ctx.organizationId },
          select: { id: true, name: true, slug: true, timezone: true, currency: true, brand: true, country: true, settings: true },
        }),
      ),
    ]);
    const { settings, ...organization } = (org ?? {}) as Record<string, any>;
    const personalization = resolvePersonalization(settings);
    // emailVerified (D6) como booleano para el frontend; no exponemos la fecha cruda.
    const { emailVerifiedAt, ...userRest } = (user ?? {}) as Record<string, any>;
    const userOut = user ? { ...userRest, emailVerified: !!emailVerifiedAt } : user;
    return { user: userOut, organization, role: ctx.roleCode, permissions: ctx.permissions, personalization };
  }

  /** Mi perfil: actualizar el nombre propio (cualquier rol). */
  @Patch("me")
  async updateMe(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ name: z.string().min(2).max(80) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Nombre inválido (2-80)");
    await this.prisma.admin.user.update({ where: { id: ctx.userId }, data: { name: parsed.data.name.trim() } });
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "profile.name_update", entityType: "user", entityId: ctx.userId },
      }),
    );
    return { ok: true };
  }

  /**
   * Preferencias de UI del usuario (F1). De partida el acento de la paleta curada de
   * F3. Merge con las settings existentes (no pisa otras claves). F3 lo consume.
   */
  @Patch("me/preferences")
  async updatePreferences(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({ accent: z.enum(ACCENT_PALETTE).optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Preferencias inválidas");
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { settings: true, brand: true } });
    // M6 — Conversia solo acepta los 6 acentos curados (Nocturna); el resto no tiene tokens de color.
    if (parsed.data.accent && user?.brand === "conversia" && !ACCENTS.includes(parsed.data.accent as (typeof ACCENTS)[number])) {
      throw new BadRequestException("Acento no disponible para esta marca");
    }
    const current = (user?.settings as Record<string, unknown>) ?? {};
    const next = { ...current, ...(parsed.data.accent ? { accent: parsed.data.accent } : {}) };
    await this.prisma.admin.user.update({ where: { id: ctx.userId }, data: { settings: next as object } });
    return { ok: true, preferences: next };
  }

  /**
   * Cambio de contraseña propio: exige la contraseña ACTUAL. Requisitos de la
   * nueva: mínimo 8 caracteres con al menos una letra y un número.
   */
  @Post("change-password")
  async changePassword(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({
        current: z.string().min(1),
        next: z.string().min(8).max(100).regex(/[a-zA-Z]/, "Debe incluir letras").regex(/[0-9]/, "Debe incluir un número"),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Contraseña inválida (mín. 8, letras y números)");
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId } });
    if (!user?.passwordHash || !bcrypt.compareSync(parsed.data.current, user.passwordHash)) {
      throw new BadRequestException("La contraseña actual no es correcta");
    }
    await this.prisma.admin.user.update({
      where: { id: ctx.userId },
      data: { passwordHash: bcrypt.hashSync(parsed.data.next, 12) },
    });
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "profile.password_change", entityType: "user", entityId: ctx.userId },
      }),
    );
    return { ok: true };
  }
}
