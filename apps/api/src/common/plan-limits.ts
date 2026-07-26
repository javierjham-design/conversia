import { ForbiddenException } from "@nestjs/common";
import type { TenantTx } from "@conversia/database";

/**
 * Enforcement de límites del plan del tenant. Se llama DENTRO de una
 * transacción withTenant (RLS activo) antes de crear un recurso.
 * Reglas:
 * - Sin suscripción activa → no se aplica límite (no romper tenants sin plan).
 * - limit ausente o 0 → ilimitado (convención del catálogo de planes).
 * - currentCount >= limit → 403 con mensaje de upgrade.
 */
export type LimitedResource = "agents" | "channels" | "workflows" | "users" | "clinics";

const LABELS: Record<LimitedResource, string> = {
  agents: "agentes",
  channels: "canales",
  workflows: "flujos",
  users: "usuarios",
  clinics: "sedes",
};

export async function enforcePlanLimit(tx: TenantTx, resource: LimitedResource, currentCount: number): Promise<void> {
  const sub = await tx.subscription.findFirst({
    where: { status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!sub) return;
  const plan = await tx.plan.findUnique({ where: { id: sub.planId } });
  const limit = (plan?.limits as Record<string, number> | undefined)?.[resource];
  if (typeof limit !== "number" || limit <= 0) return;
  if (currentCount >= limit) {
    throw new ForbiddenException(
      `Alcanzaste el límite de tu plan (${limit} ${LABELS[resource]}). Sube de plan en Configuración → Plan y facturación.`,
    );
  }
}
