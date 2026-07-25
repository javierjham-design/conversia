import { AsyncLocalStorage } from "node:async_hooks";
import { UnauthorizedException } from "@nestjs/common";

/** Contexto autenticado del request. El organizationId sale SIEMPRE del JWT. */
export interface RequestContext {
  userId: string;
  organizationId: string;
  roleCode: string;
  permissions: string[];
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
