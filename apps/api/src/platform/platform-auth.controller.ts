import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import * as bcryptMod from "bcryptjs";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";
import { PlatformGuard, type PlatformRequest } from "./platform.guard";
import { PlatformSessionService } from "./platform-session.service";
import { signPlatformToken } from "./platform.jwt";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(20).optional(),
});
const codeSchema = z.object({ code: z.string().trim().min(1).max(20) });

/** Minutos que un re-auth (password/MFA) mantiene desbloqueadas las acciones críticas. */
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

function hashRecovery(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

@Controller("platform/auth")
export class PlatformAuthController {
  constructor(
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
    private sessions: PlatformSessionService,
  ) {}

  @Post("login")
  async login(@Body() body: unknown) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Credenciales inválidas");
    const rl = await this.rateLimit.custom(`rl:platform-login:${parsed.data.email.toLowerCase()}`, 15, 900);
    if (!rl.allowed) {
      throw new HttpException("Demasiados intentos. Espera unos minutos.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { email: parsed.data.email } });
    if (!admin || !bcrypt.compareSync(parsed.data.password, admin.passwordHash)) {
      throw new UnauthorizedException("Credenciales inválidas");
    }

    // Segundo factor: obligatorio si el admin lo tiene activo.
    if (admin.mfaEnabledAt) {
      const code = parsed.data.code;
      if (!code) {
        // El frontend detecta `mfaRequired` y muestra el campo de código.
        throw new UnauthorizedException({ message: "Ingresa el código de verificación", mfaRequired: true });
      }
      const totpOk = admin.mfaSecret ? verifyTotp(admin.mfaSecret, code) : false;
      const recoveryOk = totpOk ? false : await this.consumeRecoveryCode(admin.id, admin.mfaRecoveryCodes, code);
      if (!totpOk && !recoveryOk) {
        throw new UnauthorizedException({ message: "Código de verificación inválido", mfaRequired: true });
      }
    }

    await this.prisma.admin.auditLog.create({
      data: { actorType: "platform_admin", actorId: admin.id, action: "platform.login", entityType: "platform_admin", entityId: admin.id },
    });
    const jti = await this.sessions.create(admin.id);
    return {
      token: signPlatformToken({ sub: admin.id, email: admin.email, role: admin.role, jti }),
      name: admin.name,
      role: admin.role,
      mfaEnabled: !!admin.mfaEnabledAt,
    };
  }

  @Get("me")
  @UseGuards(PlatformGuard)
  async me(@Req() req: PlatformRequest) {
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { id: req.platformAdmin!.sub } });
    return {
      admin: { id: req.platformAdmin!.sub, email: req.platformAdmin!.email, role: req.platformAdmin!.role },
      mfaEnabled: !!admin?.mfaEnabledAt,
    };
  }

  @Post("logout")
  @UseGuards(PlatformGuard)
  async logout(@Req() req: PlatformRequest) {
    await this.sessions.revoke(req.platformAdmin!.jti);
    return { ok: true };
  }

  /** Re-autenticación (password o código MFA) para desbloquear acciones críticas. */
  @Post("reauth")
  @UseGuards(PlatformGuard)
  async reauth(@Req() req: PlatformRequest, @Body() body: unknown) {
    const parsed = z.object({ password: z.string().optional(), code: z.string().trim().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { id: req.platformAdmin!.sub } });
    if (!admin) throw new UnauthorizedException();
    const pwOk = parsed.data.password ? bcrypt.compareSync(parsed.data.password, admin.passwordHash) : false;
    const codeOk = parsed.data.code && admin.mfaSecret ? verifyTotp(admin.mfaSecret, parsed.data.code) : false;
    if (!pwOk && !codeOk) throw new UnauthorizedException("Re-autenticación fallida");
    await this.sessions.touchReauth(req.platformAdmin!.jti);
    return { ok: true };
  }

  // ---- MFA (TOTP) ----

  @Get("mfa/status")
  @UseGuards(PlatformGuard)
  async mfaStatus(@Req() req: PlatformRequest) {
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { id: req.platformAdmin!.sub } });
    return { enabled: !!admin?.mfaEnabledAt, pending: !!admin?.mfaSecret && !admin?.mfaEnabledAt };
  }

  /** Genera un secreto nuevo y el URI para el QR. No activa MFA todavía. */
  @Post("mfa/enroll")
  @UseGuards(PlatformGuard)
  async mfaEnroll(@Req() req: PlatformRequest) {
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { id: req.platformAdmin!.sub } });
    if (!admin) throw new UnauthorizedException();
    if (admin.mfaEnabledAt) throw new BadRequestException("MFA ya está activo. Desactívalo primero para regenerarlo.");
    const secret = generateTotpSecret();
    await this.prisma.admin.platformAdmin.update({ where: { id: admin.id }, data: { mfaSecret: secret } });
    return { secret, otpauthUri: otpauthUri(secret, admin.email, getEnv().SUPER_ADMIN_MFA_ISSUER) };
  }

  /** Confirma el enrolamiento con un código válido y activa MFA. Devuelve códigos de recuperación UNA vez. */
  @Post("mfa/verify")
  @UseGuards(PlatformGuard)
  async mfaVerify(@Req() req: PlatformRequest, @Body() body: unknown) {
    const parsed = codeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Código inválido");
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { id: req.platformAdmin!.sub } });
    if (!admin?.mfaSecret) throw new BadRequestException("Primero genera el secreto (enroll).");
    if (!verifyTotp(admin.mfaSecret, parsed.data.code)) throw new UnauthorizedException("Código inválido");
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));
    await this.prisma.admin.platformAdmin.update({
      where: { id: admin.id },
      data: { mfaEnabledAt: new Date(), mfaRecoveryCodes: recoveryCodes.map(hashRecovery) },
    });
    await this.prisma.admin.auditLog.create({
      data: { actorType: "platform_admin", actorId: admin.id, action: "platform.mfa.enabled", entityType: "platform_admin", entityId: admin.id },
    });
    // Los códigos en claro se muestran una sola vez.
    return { enabled: true, recoveryCodes };
  }

  /** Desactiva MFA. Requiere re-auth reciente (acción crítica). */
  @Post("mfa/disable")
  @UseGuards(PlatformGuard)
  async mfaDisable(@Req() req: PlatformRequest) {
    await this.assertRecentReauth(req.platformAdmin!.jti);
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { id: req.platformAdmin!.sub } });
    if (!admin) throw new UnauthorizedException();
    await this.prisma.admin.platformAdmin.update({
      where: { id: admin.id },
      data: { mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: [] },
    });
    await this.prisma.admin.auditLog.create({
      data: { actorType: "platform_admin", actorId: admin.id, action: "platform.mfa.disabled", entityType: "platform_admin", entityId: admin.id },
    });
    return { enabled: false };
  }

  // ---- helpers ----

  private async assertRecentReauth(jti: string) {
    const s = await this.sessions.get(jti);
    if (!s || Date.now() - s.reauthAt > REAUTH_WINDOW_MS) {
      throw new HttpException("Acción crítica: vuelve a autenticarte.", HttpStatus.FORBIDDEN);
    }
  }

  /** Consume (elimina) un código de recuperación si coincide. Devuelve true si se usó. */
  private async consumeRecoveryCode(adminId: string, stored: unknown, code: string): Promise<boolean> {
    const hashes = Array.isArray(stored) ? (stored as string[]) : [];
    const target = hashRecovery(code.replace(/\s/g, ""));
    if (!hashes.includes(target)) return false;
    await this.prisma.admin.platformAdmin.update({
      where: { id: adminId },
      data: { mfaRecoveryCodes: hashes.filter((h) => h !== target) },
    });
    return true;
  }
}
