import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { enqueueNotification } from "./notifications/queue";

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}
/** SETNX con expiración: true si el aviso aún no se había enviado este período. */
async function firstTime(key: string): Promise<boolean> {
  try {
    return (await conn().set(key, "1", "EX", 40 * 24 * 3600, "NX")) === "OK";
  } catch {
    return false;
  }
}

/**
 * Bolsa de mensajes prepagada (docs/PREPAID_WALLET_DESIGN.md). Débito ATÓMICO y
 * PREVIO al envío de plantilla, idempotente por messageId. La exposición máxima
 * por cliente = su saldo (lo que ya pagó). El servicio (24 h) no toca esta bolsa: se
 * mide/controla por cupo de conversaciones (E3, ver conversation-quota.ts) — no es
 * gratis desde el 2026-10-01.
 */

export type WalletCategory = "utility" | "marketing" | "authentication" | "service";

type Weights = Record<WalletCategory, number>;
let weightCache: { at: number; byKey: Record<string, Weights> } | null = null;
let brandCache: { at: number; byOrg: Record<string, string> } | null = null;

/** Marca de la organización (cache 60 s). Para resolver los pesos por marca (F5/H2). */
export async function resolveOrgBrand(organizationId: string): Promise<string> {
  if (brandCache && Date.now() - brandCache.at < 60_000 && brandCache.byOrg[organizationId]) return brandCache.byOrg[organizationId];
  let brand = "tubot";
  try {
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    brand = (org?.brand ?? "tubot").toLowerCase();
  } catch {
    /* default tubot */
  }
  if (!brandCache || Date.now() - brandCache.at >= 60_000) brandCache = { at: Date.now(), byOrg: {} };
  brandCache.byOrg[organizationId] = brand;
  return brand;
}

/**
 * Pesos por categoría POR MARCA (F5/H2). TuBot usa la key global `walletWeights`
 * (1/1/1 — sin cambios). Conversia usa `walletWeights:conversia` (1/1/1 · marketing 4),
 * con fallback a la global si no está sembrada. Sembrar 1/1/1/4 en la key GLOBAL
 * cambiaría los débitos de TODOS los tenants TuBot — por eso la key es separada.
 */
async function readWeights(organizationId?: string): Promise<Weights> {
  const brand = organizationId ? await resolveOrgBrand(organizationId) : "tubot";
  const key = brand === "conversia" ? "walletWeights:conversia" : "walletWeights";
  if (weightCache && Date.now() - weightCache.at < 60_000 && weightCache.byKey[key]) return weightCache.byKey[key];
  const def: Weights = { utility: 1, authentication: 1, marketing: 1, service: 1 };
  try {
    const admin = getAdminPrisma();
    let row = await admin.platformSetting.findUnique({ where: { key } });
    if (!row && key !== "walletWeights") row = await admin.platformSetting.findUnique({ where: { key: "walletWeights" } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<Weights>;
      def.utility = num(parsed.utility, 1);
      def.authentication = num(parsed.authentication, 1);
      def.marketing = num(parsed.marketing, 1);
      def.service = num(parsed.service, 1);
    }
  } catch {
    /* defaults */
  }
  if (!weightCache || Date.now() - weightCache.at >= 60_000) weightCache = { at: Date.now(), byKey: {} };
  weightCache.byKey[key] = def;
  return def;
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : d;
}

/**
 * Mapea la categoría cruda de Meta a WalletCategory. Contrato EXPLÍCITO: cualquier
 * valor no reconocido devuelve { unknown: raw } — PROHIBIDO el default a "utility".
 * Antes "service" se disfrazaba de utility en silencio; ese es el bug que matamos.
 */
export function normalizeCategory(category: string | null | undefined): WalletCategory | { unknown: string } {
  const raw = (category ?? "").trim();
  const c = raw.toUpperCase();
  if (c === "UTILITY") return "utility";
  if (c.startsWith("MARKET")) return "marketing";
  if (c.startsWith("AUTH")) return "authentication";
  if (c === "SERVICE") return "service";
  return { unknown: raw };
}

/** Cupo prepago que da un valor de "Incluidos / mes" del plan (−1 = ilimitado). */
export function quotaFromPlanIncluded(templateMessages: unknown): number {
  const q = Number(templateMessages);
  if (q === -1) return 1_000_000; // "ilimitado" práctico (sigue registrando consumo)
  if (Number.isFinite(q) && q >= 0) return Math.round(q); // 0 = plan sin cupo (p. ej. Free)
  return getEnv().WALLET_DEFAULT_QUOTA; // solo sin definir (NaN) → mínimo seguro
}

/** Cupo del plan del tenant (features.templateMessages) o el mínimo seguro. */
async function planQuota(organizationId: string): Promise<number> {
  const prisma = getAdminPrisma();
  try {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { planId: true } });
    if (org?.planId) {
      const plan = await prisma.plan.findUnique({ where: { id: org.planId }, select: { features: true } });
      return quotaFromPlanIncluded((plan?.features as any)?.templateMessages);
    }
  } catch {
    /* cae al default */
  }
  return getEnv().WALLET_DEFAULT_QUOTA;
}

/** Crea la bolsa si no existe, sembrando el cupo del plan (una sola vez). */
async function ensureWallet(organizationId: string): Promise<void> {
  const prisma = getAdminPrisma();
  const existing = await prisma.messageWallet.findUnique({ where: { organizationId } });
  if (existing) return;
  const q = await planQuota(organizationId);
  await prisma.messageWallet
    .create({ data: { organizationId, balance: q, includedPerPeriod: q, carryoverCap: q } })
    .catch(() => undefined); // carrera: otro proceso la creó
  await prisma.walletLedger
    .create({ data: { organizationId, delta: q, reason: "plan_renewal", balanceAfter: q, refType: "init" } })
    .catch(() => undefined);
}

export type DebitResult =
  | { ok: true; balance: number; already?: boolean }
  | { ok: false; reason: "no_balance"; balance: number };

/**
 * Descuenta el peso de la categoría de la bolsa, ATÓMICAMENTE. Idempotente por
 * messageId: si ya se cobró ese mensaje (reintento de cola), no vuelve a descontar.
 */
export async function debitForMessage(
  organizationId: string,
  messageId: string,
  category: string | null | undefined,
  costUsd?: number,
): Promise<DebitResult> {
  const prisma = getAdminPrisma();
  await ensureWallet(organizationId);

  // Idempotencia: ¿ya se cobró este mensaje?
  const prev = await prisma.walletLedger.findFirst({
    where: { organizationId, reason: "send_debit", refType: "message", refId: messageId },
    select: { balanceAfter: true },
  });
  if (prev) return { ok: true, balance: prev.balanceAfter, already: true };

  const norm = normalizeCategory(category);
  let weight: number;
  let ledgerCategory: string;
  if (typeof norm === "object") {
    // Categoría no reconocida: cobra peso 1, se registra CRUDA (nunca disfrazada)
    // y deja aviso visible — una etiqueta inesperada no puede pasar en silencio.
    weight = 1;
    ledgerCategory = norm.unknown || "unknown";
    console.warn(`⚠ wallet: categoría de plantilla no reconocida "${norm.unknown}" (org ${organizationId}, msg ${messageId}) — cobrada peso 1 y registrada cruda`);
  } else {
    weight = (await readWeights(organizationId))[norm];
    ledgerCategory = norm;
  }

  // Débito atómico: la fila se bloquea; sin saldo suficiente → 0 filas.
  const rows = await prisma.$queryRaw<{ balance: number }[]>`
    UPDATE message_wallets SET balance = balance - ${weight}, updated_at = now()
    WHERE organization_id = ${organizationId} AND balance >= ${weight}
    RETURNING balance`;
  if (rows.length === 0) {
    const w = await prisma.messageWallet.findUnique({ where: { organizationId }, select: { balance: true } });
    return { ok: false, reason: "no_balance", balance: w?.balance ?? 0 };
  }
  const balance = rows[0].balance;
  await prisma.walletLedger
    .create({
      data: { organizationId, delta: -weight, reason: "send_debit", balanceAfter: balance, category: ledgerCategory, costUsd: costUsd ?? null, refType: "message", refId: messageId },
    })
    .catch(() => undefined);
  return { ok: true, balance };
}

/**
 * Avisos de bolsa: al 80% consumido (queda ≤20%) y al 100% (vacía). Dedupe por
 * período. En vacía, además avisa a operaciones (OPS_ALERT_WEBHOOK_URL). El aviso
 * al tenant va por el catálogo de notificaciones (in-app/correo/push).
 */
export async function notifyWalletThresholds(organizationId: string, balance: number): Promise<void> {
  try {
    const w = await getAdminPrisma().messageWallet.findUnique({
      where: { organizationId },
      select: { includedPerPeriod: true, periodStart: true },
    });
    if (!w || w.includedPerPeriod <= 0) return;
    const period = w.periodStart.toISOString().slice(0, 10);
    const pct = Math.max(0, Math.round((balance / w.includedPerPeriod) * 100));

    if (balance <= 0) {
      if (await firstTime(`wallet:alerted:empty:${organizationId}:${period}`)) {
        await enqueueNotification({ eventKey: "wallet.empty", organizationId, data: { balance: 0, pct: 0 } });
        const url = getEnv().OPS_ALERT_WEBHOOK_URL;
        if (url) {
          const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { name: true } });
          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ summary: `TuBot: bolsa agotada — ${org?.name ?? organizationId}`, description: `El tenant "${org?.name ?? organizationId}" agotó su bolsa de mensajes de plantilla. Dejó de poder enviar plantillas hasta comprar un paquete o subir de plan.`, severity: "warning" }),
          }).catch(() => undefined);
        }
      }
    } else if (pct <= 20) {
      if (await firstTime(`wallet:alerted:low:${organizationId}:${period}`)) {
        await enqueueNotification({ eventKey: "wallet.low", organizationId, data: { balance, pct } });
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Devuelve a la bolsa un débito de un mensaje (p. ej. si el fusible cortó luego). */
export async function refundForMessage(organizationId: string, messageId: string): Promise<void> {
  const prisma = getAdminPrisma();
  const debit = await prisma.walletLedger.findFirst({
    where: { organizationId, reason: "send_debit", refType: "message", refId: messageId },
    orderBy: { createdAt: "desc" },
  });
  if (!debit) return;
  // Evita doble refund.
  const already = await prisma.walletLedger.findFirst({ where: { organizationId, reason: "refund", refType: "message", refId: messageId } });
  if (already) return;
  const amount = Math.abs(debit.delta);
  const rows = await prisma.$queryRaw<{ balance: number }[]>`
    UPDATE message_wallets SET balance = balance + ${amount}, updated_at = now()
    WHERE organization_id = ${organizationId} RETURNING balance`;
  const balance = rows[0]?.balance ?? amount;
  await prisma.walletLedger
    .create({ data: { organizationId, delta: amount, reason: "refund", balanceAfter: balance, refType: "message", refId: messageId } })
    .catch(() => undefined);
}
