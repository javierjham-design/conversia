import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";

/**
 * Bolsa de mensajes prepagada (docs/PREPAID_WALLET_DESIGN.md). Débito ATÓMICO y
 * PREVIO al envío de plantilla, idempotente por messageId. La exposición máxima
 * por cliente = su saldo (lo que ya pagó). Servicio (24 h) no toca la bolsa.
 */

export type WalletCategory = "utility" | "marketing" | "authentication";

type Weights = Record<WalletCategory, number>;
let weightCache: { at: number; w: Weights } | null = null;

/** Pesos por categoría (A: 1/1/1 = por cantidad · B: marketing 4 = ponderado). */
async function readWeights(): Promise<Weights> {
  if (weightCache && Date.now() - weightCache.at < 60_000) return weightCache.w;
  const def: Weights = { utility: 1, authentication: 1, marketing: 1 };
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: "walletWeights" } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<Weights>;
      def.utility = num(parsed.utility, 1);
      def.authentication = num(parsed.authentication, 1);
      def.marketing = num(parsed.marketing, 1);
    }
  } catch {
    /* defaults */
  }
  weightCache = { at: Date.now(), w: def };
  return def;
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : d;
}

function normalizeCategory(category: string | null | undefined): WalletCategory {
  const c = (category ?? "").toUpperCase();
  if (c.startsWith("MARKET")) return "marketing";
  if (c.startsWith("AUTH")) return "authentication";
  return "utility";
}

/** Cupo prepago que da un valor de "Incluidos / mes" del plan (−1 = ilimitado). */
export function quotaFromPlanIncluded(templateMessages: unknown): number {
  const q = Number(templateMessages);
  if (q === -1) return 1_000_000; // "ilimitado" práctico (sigue registrando consumo)
  if (Number.isFinite(q) && q > 0) return Math.round(q);
  return getEnv().WALLET_DEFAULT_QUOTA; // 0 / sin definir → mínimo seguro
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

  const cat = normalizeCategory(category);
  const weight = (await readWeights())[cat];

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
      data: { organizationId, delta: -weight, reason: "send_debit", balanceAfter: balance, category: cat, costUsd: costUsd ?? null, refType: "message", refId: messageId },
    })
    .catch(() => undefined);
  return { ok: true, balance };
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
