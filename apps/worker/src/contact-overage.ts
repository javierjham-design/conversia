/**
 * EXCEDENTE DE CONTACTOS (post-pago, sin fuga de plata).
 *
 * Cada plan incluye un cupo de contactos/mes (plan.limits.contactsMonthly). Si un
 * tenant lo supera, NO se corta el servicio: se acumula el excedente como un
 * "billable" en org.settings.billables, que el motor de cobro ya suma a la próxima
 * factura (base + billables). Si no paga, el DUNNING existente suspende → cero fuga.
 *
 * El medidor corre periódico y RECALCULA (idempotente): el billable de excedente se
 * sobreescribe con el valor del período actual, así nunca cobra de más ni se salta un
 * cobro aunque una corrida falle. Al renovar el período (nuevo periodStart), el conteo
 * vuelve a 0 y el billable se limpia solo en la siguiente corrida.
 */
import { getAdminPrisma } from "@conversia/database";

export const OVERAGE_KIND = "contact_overage";

interface Billable {
  concept: string;
  amount: number;
  kind?: string;
}

/** Cálculo PURO del excedente (testeable). Devuelve null si no hay excedente. */
export function computeContactOverage(input: {
  contactsInPeriod: number;
  cupo: number; // 0 o negativo = ilimitado → sin excedente
  packSize: number;
  packPrice: number; // en la moneda del tenant
}): { packs: number; amount: number } | null {
  const { contactsInPeriod, cupo, packSize, packPrice } = input;
  if (!cupo || cupo <= 0) return null; // ilimitado
  if (!packSize || packSize <= 0 || !packPrice || packPrice <= 0) return null; // sin pack configurado
  const excess = contactsInPeriod - cupo;
  if (excess <= 0) return null;
  const packs = Math.ceil(excess / packSize);
  return { packs, amount: packs * packPrice };
}

/** Reemplaza el billable de excedente en settings (quita el previo; agrega el nuevo si aplica). */
export function applyOverageBillable(
  settings: Record<string, unknown>,
  overage: { packs: number; amount: number } | null,
  concept: string,
): Record<string, unknown> {
  const prev = Array.isArray(settings.billables) ? (settings.billables as Billable[]) : [];
  const kept = prev.filter((b) => b?.kind !== OVERAGE_KIND); // preserva billables manuales
  const next = overage ? [...kept, { concept, amount: overage.amount, kind: OVERAGE_KIND }] : kept;
  return { ...settings, billables: next };
}

/** Corre el medidor para todos los tenants con suscripción activa/past_due. Best-effort. */
export async function meterContactOverage(): Promise<{ scanned: number; withOverage: number }> {
  const admin = getAdminPrisma();
  const subs = await admin.subscription.findMany({
    where: { status: { in: ["ACTIVE", "PAST_DUE"] } },
    select: { organizationId: true, periodStart: true, planId: true },
  });
  let withOverage = 0;
  for (const s of subs) {
    try {
      const [plan, org] = await Promise.all([
        admin.plan.findUnique({ where: { id: s.planId }, select: { limits: true, features: true } }),
        admin.organization.findUnique({ where: { id: s.organizationId }, select: { currency: true, settings: true } }),
      ]);
      if (!plan || !org) continue;
      const cupo = Number((plan.limits as Record<string, unknown> | null)?.contactsMonthly ?? 0);
      const feat = (plan.features as Record<string, unknown> | null) ?? {};
      const packSize = Number(feat.contactPackSize ?? 100);
      const currency = org.currency ?? "CLP";
      const packPrice = Number(currency === "CLP" ? feat.contactPackPriceClp : feat.contactPackPriceUsd) || 0;

      // Contactos creados en el período de facturación en curso (o el mes calendario).
      const periodStart = s.periodStart ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const contactsInPeriod = await admin.contact.count({
        where: { organizationId: s.organizationId, createdAt: { gte: periodStart }, deletedAt: null },
      });

      const overage = computeContactOverage({ contactsInPeriod, cupo, packSize, packPrice });
      const settings = (org.settings as Record<string, unknown> | null) ?? {};
      const concept = overage
        ? `Excedente de contactos: ${overage.packs} pack(s) de ${packSize} (${contactsInPeriod}/${cupo} usados)`
        : "";
      const nextSettings = applyOverageBillable(settings, overage, concept);

      // Solo escribe si cambió (evita writes inútiles).
      const before = JSON.stringify((settings as { billables?: unknown }).billables ?? []);
      const after = JSON.stringify((nextSettings as { billables?: unknown }).billables ?? []);
      if (before !== after) {
        await admin.organization.update({ where: { id: s.organizationId }, data: { settings: nextSettings as object } });
      }
      if (overage) withOverage++;
    } catch (err) {
      console.error(`✖ meterContactOverage (${s.organizationId}):`, (err as Error).message);
    }
  }
  return { scanned: subs.length, withOverage };
}

/** Arranca el medidor: corre al inicio y luego cada 6 h. Devuelve stop(). */
export function startContactOverageMeter(): () => void {
  const tick = () =>
    void meterContactOverage()
      .then((r) => r.withOverage && console.log(`⚑ Excedente de contactos: ${r.withOverage}/${r.scanned} tenants`))
      .catch((e) => console.error("meterContactOverage:", (e as Error).message));
  const timer = setInterval(tick, 6 * 3600_000);
  timer.unref?.();
  const first = setTimeout(tick, 60_000);
  first.unref?.();
  console.log("✔ Medidor de excedente de contactos activo (cada 6 h)");
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
