import { ForbiddenException } from "@nestjs/common";
import type { TenantTx } from "@conversia/database";
import { getContext } from "../tenancy/context";

/**
 * MOTOR DE ENTITLEMENTS (Fase B) — punto ÚNICO de verdad de los límites y
 * funciones de cada tenant, resuelto server-side dentro de `withTenant` (RLS).
 * Reglas: sin suscripción activa o límite 0 → ilimitado (no romper tenants sin
 * plan). Nunca confiar en el frontend. Los controladores llaman a `enforceLimit`
 * antes de crear un recurso; las rutas de features llaman a `canUseFeature`.
 */
export type LimitedResource = "agents" | "channels" | "workflows" | "users" | "clinics";

const LABELS: Record<string, string> = {
  agents: "agentes",
  channels: "canales",
  workflows: "flujos",
  users: "usuarios",
  clinics: "sedes",
};

// Estados de suscripción que otorgan entitlements. `as const` + cast al enum de Prisma.
const ACTIVE_STATUSES = ["ACTIVE", "TRIALING"] as const;

export interface Entitlements {
  hasSubscription: boolean;
  status: string | null;
  planCode: string | null;
  limits: Record<string, number>;
  features: Record<string, unknown>;
}

/** Resuelve el plan + suscripción activos del tenant (dentro de withTenant/RLS). */
export async function getEntitlements(tx: TenantTx): Promise<Entitlements> {
  const sub = await tx.subscription.findFirst({
    where: { status: { in: ACTIVE_STATUSES as unknown as string[] } as never },
    orderBy: { createdAt: "desc" },
  });
  if (!sub) return { hasSubscription: false, status: null, planCode: null, limits: {}, features: {} };
  const plan = await tx.plan.findUnique({ where: { id: sub.planId } });
  return {
    hasSubscription: true,
    status: sub.status,
    planCode: plan?.code ?? null,
    limits: (plan?.limits as Record<string, number>) ?? {},
    features: (plan?.features as Record<string, unknown>) ?? {},
  };
}

/** Límite numérico de un recurso (null = sin plan; 0 = ilimitado por convención). */
export async function getFeatureLimit(tx: TenantTx, resource: string): Promise<number | null> {
  const ent = await getEntitlements(tx);
  const v = ent.limits[resource];
  return typeof v === "number" ? v : null;
}

/** ¿La feature está habilitada por el plan? Sin plan → no se restringen features. */
export async function canUseFeature(tx: TenantTx, feature: string): Promise<boolean> {
  const ent = await getEntitlements(tx);
  if (!ent.hasSubscription) return true;
  return ent.features[feature] === true;
}

export async function getSubscriptionStatus(tx: TenantTx): Promise<string | null> {
  return (await getEntitlements(tx)).status;
}

/**
 * Suspensión real en la escritura: si la organización está SUSPENDED/CANCELLED,
 * se bloquea la creación de recursos. Lee el estado por id explícito del contexto
 * (RLS-safe). Sin contexto (worker/webhooks) no aplica aquí — el worker tiene su
 * propio corte de IA.
 */
export async function assertOrgActive(tx: TenantTx): Promise<void> {
  const orgId = getContext()?.organizationId;
  if (!orgId) return;
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { status: true } });
  if (org && (org.status === "SUSPENDED" || org.status === "CANCELLED")) {
    throw new ForbiddenException("Tu cuenta está suspendida. Regulariza tu plan para volver a crear o modificar recursos.");
  }
}

/**
 * Enforcement de un límite de recurso (403 al exceder). Punto único de verdad
 * de los límites duros que consumen los controladores.
 */
export async function enforceLimit(tx: TenantTx, resource: string, currentCount: number): Promise<void> {
  await assertOrgActive(tx); // suspensión → 403 antes de mirar el límite
  const limit = await getFeatureLimit(tx, resource);
  if (typeof limit !== "number" || limit <= 0) return;
  if (currentCount >= limit) {
    const label = LABELS[resource] ?? resource;
    throw new ForbiddenException(
      `Alcanzaste el límite de tu plan (${limit} ${label}). Sube de plan en Configuración → Plan y facturación.`,
    );
  }
}

/** Alias de compatibilidad — los controladores ya importan `enforcePlanLimit`. */
export const enforcePlanLimit = enforceLimit;
