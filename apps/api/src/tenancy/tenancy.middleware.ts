import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import * as jwt from "jsonwebtoken";
import { getEnv } from "@conversia/config";
import { runWithContext, type RequestContext } from "./context";

/** Rutas sin JWT: auth, webhooks (firma propia) y health. */
const PUBLIC_PREFIXES = ["/auth/login", "/auth/register", "/webhooks", "/health"];

export interface JwtPayload {
  sub: string;
  orgId: string;
  role: string;
  perms: string[];
}

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
    let payload: JwtPayload;
    try {
      payload = jwt.verify(header.slice(7), getEnv().JWT_SECRET) as JwtPayload;
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
