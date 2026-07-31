import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { verifyAppToken, type AppTokenClaims } from "../auth/jwt";
import { runWithContext, type RequestContext } from "./context";

/** Rutas sin JWT: auth, webhooks (firma propia), API pública (API key) y health. */
const PUBLIC_PREFIXES = ["/auth/login", "/auth/register", "/auth/google", "/webhooks", "/billing/webhooks", "/public", "/health", "/hooks"];

/** @deprecated usar AppTokenClaims de auth/jwt */
export type JwtPayload = AppTokenClaims;

@Injectable()
export class TenancyMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    // originalUrl: req.path es relativo al punto de montaje en Express 5
    const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
      return next();
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Falta token Bearer");
    }
    let payload: AppTokenClaims;
    try {
      payload = verifyAppToken(header.slice(7)); // HS256 fijo + iss/aud validados
    } catch {
      throw new UnauthorizedException("Token inválido o expirado");
    }
    const ctx: RequestContext = {
      userId: payload.sub,
      organizationId: payload.orgId,
      roleCode: payload.role,
      permissions: payload.perms ?? [],
    };
    // El contexto envuelve TODO el manejo del request (controllers incluidos)
    runWithContext(ctx, () => next());
  }
}
