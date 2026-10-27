import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { verifyPlatformToken, type PlatformClaims } from "./platform.jwt";
import { PlatformSessionService } from "./platform-session.service";
import { isFullPlatformAdmin, operatorMayAccess } from "./platform-policy";

export interface PlatformRequest extends Request {
  platformAdmin?: PlatformClaims;
}

/** Marca del super admin que hace la petición. Default `tubot` (comportamiento histórico). */
export function platformReqBrand(req: PlatformRequest): string {
  return req.platformAdmin?.brand ?? "tubot";
}

/**
 * §6.2 — Bloquea una escritura de configuración GLOBAL (pagos, etc.) si el admin no es de TuBot.
 * Las credenciales de Flow/Lemon son globales y compartidas: un admin de Conversia podía pisar
 * las de TuBot. Hasta tener claves por marca, solo TuBot administra esos ajustes globales.
 */
export function assertTubotBrand(req: PlatformRequest): void {
  if (platformReqBrand(req) !== "tubot") {
    throw new ForbiddenException("Esta configuración global solo la administra TuBot");
  }
}

/**
 * §3.7 — IP real del cliente, vía `req.ip` (Express la deriva con `trust proxy`, ver
 * main.ts). Antes se leía el PRIMER valor de `X-Forwarded-For` a mano: ese valor lo
 * escribe quien hace la petición, así que la allowlist de IP del super admin se saltaba
 * mandando `X-Forwarded-For: <una de la lista>`. Era la 2ª capa de defensa del panel
 * más sensible del sistema.
 */
function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "";
}

/**
 * Rutas alcanzables SIN MFA activo: autenticarse, ver el propio estado y enrolar
 * el segundo factor. Todo lo demás queda bloqueado hasta activar MFA.
 *
 * §3.10 — se evalúa sobre el PATH, sin query string, y exigiendo que empiece por el
 * prefijo. Con `includes()` sobre la URL completa, cualquier ruta del panel se eximía
 * del MFA colgándole `?x=/platform/auth/` al final.
 */
function isMfaExempt(req: Request): boolean {
  const path = (req.originalUrl || req.url || "").split("?")[0];
  return path.startsWith("/platform/auth/");
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

    // F10 — autorización por rol: el OPERADOR opera la ficha de clientes pero no la
    // configuración GLOBAL de la plataforma. El super admin (owner/admin) pasa todo.
    const path = (req.originalUrl || req.url || req.path || "").split("?")[0];
    if (!isFullPlatformAdmin(claims.role) && !operatorMayAccess(path)) {
      throw new ForbiddenException("Tu rol de operador no permite esta acción (reservada al super admin).");
    }
    return true;
  }
}
