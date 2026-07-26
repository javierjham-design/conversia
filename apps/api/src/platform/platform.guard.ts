import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { verifyPlatformToken, type PlatformClaims } from "./platform.jwt";

export interface PlatformRequest extends Request {
  platformAdmin?: PlatformClaims;
}

/** Protege las rutas /platform/* con el token de administrador de plataforma. */
@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<PlatformRequest>();
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
