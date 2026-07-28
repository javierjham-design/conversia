import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { verifyPlatformToken, type PlatformClaims } from "./platform.jwt";

export interface PlatformRequest extends Request {
  platformAdmin?: PlatformClaims;
}

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "";
}

/** Protege las rutas /platform/* con el token de administrador de plataforma. */
@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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
    try {
      req.platformAdmin = verifyPlatformToken(header.slice(7));
      return true;
    } catch {
      throw new UnauthorizedException("Token de plataforma inválido o expirado");
    }
  }
}
