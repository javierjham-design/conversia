import { HttpException, HttpStatus, Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { getContext } from "../tenancy/context";
import { RateLimitService } from "./rate-limit";

/**
 * Rate limit global para rutas autenticadas, keyed por userId (confiable, del
 * JWT ya verificado). Protege contra escaneo BOLA/IDOR, disparo masivo de
 * agentes IA y abuso de API. Corre después de TenancyMiddleware.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(private rateLimit: RateLimitService) {}

  async use(_req: Request, res: Response, next: NextFunction) {
    const ctx = getContext();
    if (!ctx) return next(); // rutas públicas: su propio límite (auth) o sin sesión
    const rl = await this.rateLimit.api(ctx.userId);
    res.setHeader("x-ratelimit-remaining", String(Math.max(0, rl.count === 0 ? 999 : 0)));
    if (!rl.allowed) {
      throw new HttpException("Límite de solicitudes excedido. Reduce el ritmo.", HttpStatus.TOO_MANY_REQUESTS);
    }
    next();
  }
}
