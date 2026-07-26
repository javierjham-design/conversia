import { ForbiddenException } from "@nestjs/common";
import { hasPermission } from "@conversia/types";
import { requireContext, type RequestContext } from "./context";

/** Exige un permiso del rol (p.ej. "users:write"); owner/admin tienen "*". */
export function requirePermission(perm: string): RequestContext {
  const ctx = requireContext();
  if (!hasPermission(ctx.permissions, perm)) {
    throw new ForbiddenException(`Tu rol no tiene el permiso ${perm}`);
  }
  return ctx;
}
