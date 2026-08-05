import { ForbiddenException } from "@nestjs/common";
import type { TenantTx } from "@conversia/database";
import { getContext } from "../tenancy/context";

/**
 * MOTOR DE ENTITLEMENTS (Fase B) — punto ÚNICO de verdad de los límites y
 * funciones de cada tenant, resuelto server-side dentro de `withTenant` (RLS).
 * Reglas: sin suscripción activa → límites del **plan GRATUITO** (nunca ilimitado);
 * límite 0 dentro de un plan = ilimitado por convención. Nunca confiar en el
 * frontend. Los controladores llaman a `enforceLimit` antes de crear un recurso;
 * las rutas de features llaman a `canUseFeature`.
 */
export type LimitedResource = "agents" | "channels" | "workflows" | "users" | "clinics";

/** Límites de respaldo si el plan `free` no existe en el catálogo (conservadores). */
const FREE_FALLBACK_LIMITS: Record<string, number> = { agents: 2, channels: 1, workflows: 3, users: 2, clinics: 1 };

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
  limits: Record<string, number>; // efectivos: plan + override por-tenant
  features: Record<string, unknown>;
  validUntil: string | null;
  expired: boolean;
}

/**
 * Resuelve los entitlements EFECTIVOS del tenant (dentro de withTenant/RLS):
 * límites del plan combinados con el override por-tenant (`settings.limits`) —
 * el override manda — más la vigencia (`settings.validUntil`).
 */
export async function getEntitlements(tx: TenantTx): Promise<Entitlements> {
  const orgId = getContext()?.organizationId;
  const [sub, org] = await Promise.all([
    tx.subscription.findFirst({
      where: { status: { in: ACTIVE_STATUSES as unknown as string[] } as never },
      orderBy: { createdAt: "desc" },
    }),
    orgId ? tx.organization.findUnique({ where: { id: orgId }, select: { settings: true } }) : Promise.resolve(null),
  ]);
  const settings = (org?.settings ?? {}) as Record<string, any>;
  const override = settings.limits && typeof settings.limits === "object" ? (settings.limits as Record<string, number>) : {};
  const validUntil = typeof settings.validUntil === "string" ? settings.validUntil : null;
  const expired = validUntil ? new Date(validUntil).getTime() < Date.now() : false;

  // Con suscripción → su plan. Sin suscripción → plan GRATUITO (nunca ilimitado).
  const plan = sub
    ? await tx.plan.findUnique({ where: { id: sub.planId } })
    : await tx.plan.findUnique({ where: { code: "free" } });
  const planLimits = (plan?.limits as Record<string, number>) ?? (sub ? {} : FREE_FALLBACK_LIMITS);
  return {
    hasSubscription: !!sub,
    status: sub?.status ?? null,
    planCode: plan?.code ?? (sub ? null : "free"),
    limits: { ...planLimits, ...override }, // el override por-tenant tiene prioridad
    features: (plan?.features as Record<string, unknown>) ?? {},
    validUntil,
    expired,
  };
}

/** Límite numérico de un recurso (null = sin plan; 0 = ilimitado por convención). */
export async function getFeatureLimit(tx: TenantTx, resource: string): Promise<number | null> {
  const ent = await getEntitlements(tx);
  const v = ent.limits[resource];
  return typeof v === "number" ? v : null;
}

/** ¿La feature está habilitada por el plan? Sin plan → features del plan gratuito. */
export async function canUseFeature(tx: TenantTx, feature: string): Promise<boolean> {
  const ent = await getEntitlements(tx);
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
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { status: true, settings: true } });
  if (!org) return;
  if (org.status === "SUSPENDED" || org.status === "CANCELLED") {
    throw new ForbiddenException("Tu cuenta está suspendida. Regulariza tu plan para volver a crear o modificar recursos.");
  }
  const validUntil = (org.settings as any)?.validUntil;
  if (typeof validUntil === "string" && new Date(validUntil).getTime() < Date.now()) {
    throw new ForbiddenException("La vigencia de tu servicio venció. Renueva para seguir operando.");
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

export interface TemplateUsage {
  used: number;
  included: number; // -1 = ilimitado
  overageCount: number;
  overagePriceUsd: number;
  overageEstimateUsd: number;
  periodStart: string;
}

/**
 * Uso de mensajes de plantilla facturables del período (cupo incluido + excedente).
 * `included`/`overagePriceUsd` vienen del plan (features.templateMessages/
 * templateOverageUsd). El excedente se estima en USD (con tu margen ya incluido en
 * el precio del plan). Cuenta los usage_events `whatsapp_message` (solo facturables).
 */
export async function getTemplateUsage(tx: TenantTx): Promise<TemplateUsage> {
  const ent = await getEntitlements(tx);
  const included = typeof ent.features.templateMessages === "number" ? (ent.features.templateMessages as number) : 0;
  const overagePriceUsd = typeof ent.features.templateOverageUsd === "number" ? (ent.features.templateOverageUsd as number) : 0;
  const sub = await tx.subscription.findFirst({
    where: { status: { in: ACTIVE_STATUSES as unknown as string[] } as never },
    orderBy: { createdAt: "desc" },
    select: { periodStart: true },
  });
  const now = new Date();
  const periodStart = sub?.periodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const agg = await tx.usageEvent.aggregate({ where: { type: "whatsapp_message", occurredAt: { gte: periodStart } }, _count: { _all: true } });
  const used = agg._count._all;
  const overageCount = included < 0 ? 0 : Math.max(0, used - included);
  return { used, included, overageCount, overagePriceUsd, overageEstimateUsd: Number((overageCount * overagePriceUsd).toFixed(4)), periodStart: periodStart.toISOString() };
}
