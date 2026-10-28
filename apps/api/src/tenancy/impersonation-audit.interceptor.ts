import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { tap } from "rxjs/operators";
import type { Observable } from "rxjs";
import { PrismaService } from "../prisma.service";
import { getContext } from "./context";

/** Métodos que CAMBIAN algo. Un GET bajo impersonación es mirar, y no se audita. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * §3.2 — Bitácora de lo que hace una sesión de IMPERSONACIÓN.
 *
 * Antes, el único rastro era el `platform.impersonate` del momento de entrar: quedaba
 * registrado QUE un super admin entró como el cliente, pero no qué hizo adentro. Las
 * filas de auditoría que escriben los controladores llevan `actorId` = el usuario del
 * cliente, así que una acción del super admin era indistinguible de una del dueño real.
 *
 * Se resuelve en UN punto (un interceptor global) en vez de repartir el claim `imp` por
 * los ~128 `auditLog.create` del código: cada petición que modifica algo con un token de
 * impersonación deja una fila `platform.impersonated_action` con quién, qué ruta y qué
 * método. Así la fila del controlador cuenta el cambio y esta cuenta quién lo pidió.
 *
 * Best-effort absoluto: si la auditoría falla, la petición sigue. Preferimos perder una
 * fila de bitácora antes que romperle una acción al super admin que está ayudando.
 */
@Injectable()
export class ImpersonationAuditInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = getContext();
    const superAdminId = ctx?.impersonatedBy;
    if (!superAdminId || !MUTATING.has(req.method)) return next.handle();

    const organizationId = ctx!.organizationId;
    const userId = ctx!.userId;
    const path = (req.originalUrl || req.url || "").split("?")[0];
    const method = req.method;

    // Solo se registra si la acción SALIÓ BIEN: una petición rechazada no cambió nada.
    return next.handle().pipe(
      tap(() => {
        void this.prisma
          .withTenant(organizationId, (tx) =>
            tx.auditLog.create({
              data: {
                organizationId,
                actorType: "platform_admin",
                actorId: superAdminId,
                action: "platform.impersonated_action",
                entityType: "user",
                entityId: userId,
                after: { method, path, impersonatedUserId: userId },
              },
            }),
          )
          .catch(() => undefined);
      }),
    );
  }
}
