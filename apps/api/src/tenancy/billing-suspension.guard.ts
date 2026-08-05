import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { getAdminPrisma } from "@conversia/database";
import { getContext } from "./context";

/** Métodos de lectura: nunca se bloquean (panel en solo lectura al suspender). */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Escrituras SIEMPRE permitidas aunque la cuenta esté suspendida: pagar,
 * autenticación/salir, plataforma (Super Admin), y las rutas públicas/webhooks
 * que no llevan contexto de tenant.
 */
const ALLOW_PREFIXES = ["/billing", "/auth", "/platform", "/webhooks", "/public", "/hooks", "/health"];

/**
 * Suspensión por impago = panel en SOLO LECTURA. Bloquea toda mutación
 * (POST/PUT/PATCH/DELETE) de un tenant SUSPENDED/CANCELLED con **402 Payment
 * Required**, salvo la allowlist (para que pueda pagar y reactivar). Las lecturas
 * siguen funcionando y los datos no se tocan.
 */
@Injectable()
export class BillingSuspensionGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (READ_METHODS.has(req.method)) return true;
    const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
    if (ALLOW_PREFIXES.some((p) => path.startsWith(p))) return true;

    const context = getContext();
    if (!context?.organizationId) return true; // sin tenant → otros guards deciden

    const org = await getAdminPrisma().organization.findUnique({
      where: { id: context.organizationId },
      select: { status: true },
    });
    if (org && (org.status === "SUSPENDED" || org.status === "CANCELLED")) {
      throw new HttpException(
        "Cuenta suspendida por falta de pago. Regulariza tu plan para reactivar el servicio; tus datos están intactos.",
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
