import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { verifyAppToken, type AppTokenClaims } from "../auth/jwt";
import { runWithContext, type RequestContext } from "./context";

/**
 * Rutas sin JWT: auth, webhooks (firma propia), API pública (API key) y health.
 *
 * §10.5 — `/auth/forgot` y `/auth/reset` son públicas por definición: quien las usa es
 * justamente alguien que NO puede iniciar sesión. Se autentican por el token del enlace.
 *
 * §3.10 — `/auth/invite` y `/auth/accept-invite` van acá porque el frontend las llama SIN
 * Bearer (`AUTH_API_PATHS` en apps/web/src/lib/api.ts): el invitado todavía no tiene sesión.
 * Sin esto el middleware cortaba con "Falta token Bearer" y el link de invitación no servía.
 * Se autentican por el token del propio link (`verifyInviteToken`, audiencia `:invite`).
 */
const PUBLIC_PREFIXES = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout", "/auth/google", "/auth/mfa", "/auth/verify-email", "/auth/forgot", "/auth/reset", "/auth/invite", "/auth/accept-invite", "/webhooks", "/billing/webhooks", "/public", "/health", "/hooks"];

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
    // TECHO DE LA SESIÓN (claim `sxp`): un token cuya sesión ya murió no sirve, aunque su
    // propio `exp` siga en el futuro. En teoría no puede existir —`vidaDelAccessToken` le
    // recorta el `exp` al techo— y justamente por eso se revisa acá: si mañana aparece otro
    // camino que emita sesiones y se olvide del recorte, el techo se sigue cumpliendo. Los
    // tokens sin `sxp` (TuBot, token MCP) no cambian en nada.
    if (typeof payload.sxp === "number" && payload.sxp * 1000 <= Date.now()) {
      throw new UnauthorizedException("Sesión expirada");
    }
    const ctx: RequestContext = {
      userId: payload.sub,
      organizationId: payload.orgId,
      roleCode: payload.role,
      permissions: payload.perms ?? [],
      // §3.2 — sesión de impersonación: el contexto recuerda QUIÉN la pidió.
      ...(payload.imp ? { impersonatedBy: payload.imp } : {}),
      // Techo de la sesión en curso: `switchOrg` lo hereda para no estrenar uno nuevo.
      ...(typeof payload.sxp === "number" ? { sessionExpiresAt: payload.sxp * 1000 } : {}),
    };
    // El contexto envuelve TODO el manejo del request (controllers incluidos)
    runWithContext(ctx, () => next());
  }
}
