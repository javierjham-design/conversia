import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { verifyPlatformToken, type PlatformClaims } from "./platform.jwt";
import { PlatformSessionService } from "./platform-session.service";

export interface PlatformRequest extends Request {
  platformAdmin?: PlatformClaims;
}

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "";
}

/**
 * Rutas alcanzables SIN MFA activo: autenticarse, ver el propio estado y enrolar
 * el segundo factor. Todo lo demás queda bloqueado hasta activar MFA.
 */
function isMfaExempt(req: Request): boolean {
  return (req.originalUrl || req.url || "").includes("/platform/auth/");
}

/** Protege las rutas /platform/* con el token de administrador de plataforma. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private sessions: PlatformSessionService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlatformRequest>();

    // 2ª capa (opcional): allowlist de IP. Vacío = sin restricción (default seguro).
    const allow = getEnv().SUPER_ADMIN_ALLOWED_IPS;
    if (allow) {
      const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
      if (!list.includes(clientIp(req))) {
        throw new UnauthorizedException("Acceso no permitido desde esta ubicación");
      }
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Falta token de plataforma");
    let claims: PlatformClaims;
    try {
      claims = verifyPlatformToken(header.slice(7));
    } catch {
      throw new UnauthorizedException("Token de plataforma inválido o expirado");
    }
    // La sesión debe seguir viva en Redis (permite revocación / logout remoto).
    if (!(await this.sessions.isValid(claims.jti))) {
      throw new UnauthorizedException("Sesión cerrada o revocada. Inicia sesión de nuevo.");
    }
    req.platformAdmin = claims;

    // MFA obligatorio: sin segundo factor activo, solo se permite /platform/auth/*
    // (para poder enrolarlo). El resto del panel exige MFA.
    if (getEnv().SUPER_ADMIN_REQUIRE_MFA && !isMfaExempt(req)) {
      const admin = await this.prisma.admin.platformAdmin.findUnique({
        where: { id: claims.sub },
        select: { mfaEnabledAt: true },
      });
      if (!admin?.mfaEnabledAt) {
        throw new ForbiddenException({
          message: "Activa la autenticación en dos pasos (MFA) para continuar.",
          mfaSetupRequired: true,
        });
      }
    }
    return true;
  }
}
