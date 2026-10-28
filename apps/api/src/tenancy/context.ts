import { AsyncLocalStorage } from "node:async_hooks";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";

/** Contexto autenticado del request. El organizationId sale SIEMPRE del JWT. */
export interface RequestContext {
  userId: string;
  organizationId: string;
  roleCode: string;
  permissions: string[];
  /**
   * §3.2 — id del super admin que impersona al usuario (claim `imp` del JWT). Si está
   * presente, la sesión es PRESTADA: sirve para operar la ficha del cliente, no para
   * tomar posesión de su cuenta. Lo usa `assertNotImpersonating`.
   */
  impersonatedBy?: string;
}

/**
 * §3.2 — Niega una acción de CUENTA cuando la sesión es de impersonación.
 *
 * El super admin entra con un token `imp` de 30 minutos para ayudar al cliente. Con esa
 * sesión no puede cambiar la contraseña, tocar el 2.º factor, cambiarse de organización
 * ni editar el perfil: eso dejaría al cliente fuera de su propia cuenta y sin rastro de
 * quién lo hizo. El super admin tiene rutas propias y auditadas en /platform para eso.
 */
export function assertNotImpersonating(session: { impersonatedBy?: string }, accion: string): void {
  if (session.impersonatedBy) {
    throw new ForbiddenException(
      `Estás viendo esta cuenta como super admin (sesión de soporte): no puedes ${accion}. Usa las acciones de /platform, que quedan auditadas.`,
    );
  }
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return als.getStore();
}

export function requireContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) throw new UnauthorizedException("Sesión no autenticada");
  return ctx;
}
