/**
 * EXCEDENTE DE CONTACTOS (post-pago, sin fuga de plata).
 *
 * Cada plan incluye un cupo de contactos ACTIVOS/mes (plan.limits.contactsMonthly):
 * contactos con al menos un mensaje enviado o recibido en el ciclo mensual (NO los
 * creados/importados — un backfill no consume cupo). Si un tenant lo supera, NO se
 * corta el servicio: se acumula el excedente como un "billable" en
 * org.settings.billables, que el motor de cobro ya suma a la próxima factura
 * (base + billables). Si no paga, el DUNNING existente suspende → cero fuga.
 *
 * El medidor corre periódico y RECALCULA (idempotente): el billable de excedente se
 * sobreescribe con el valor del período actual, así nunca cobra de más ni se salta un
 * cobro aunque una corrida falle. El ciclo rota solo cada mes (aniversario del
 * periodStart) y el billable se limpia en la siguiente corrida.
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
      // Cupo = override por-tenant (org.settings.limits.contactsMonthly) → plan. El override manda.
      const settingsLimits = (org.settings as { limits?: Record<string, unknown> } | null)?.limits;
      const overrideCupo = typeof settingsLimits?.contactsMonthly === "number" ? settingsLimits.contactsMonthly : undefined;
      const planCupo = Number((plan.limits as Record<string, unknown> | null)?.contactsMonthly ?? 0);
      const cupo = overrideCupo ?? planCupo;
      const feat = (plan.features as Record<string, unknown> | null) ?? {};
      const packSize = Number(feat.contactPackSize ?? 100);
      const currency = org.currency ?? "CLP";
      const packPrice = Number(currency === "CLP" ? feat.contactPackPriceClp : feat.contactPackPriceUsd) || 0;

      // Contactos ACTIVOS del mes: con al menos un mensaje (enviado o recibido) en el
      // ciclo. Antes se contaban contactos CREADOS desde periodStart → un backfill de
      // leads (Meta) inflaba el uso y FACTURABA excedente por contactos sin actividad.
      // Corte mensual RODANTE anclado al día del ciclo (aniversario más reciente; los
      // días >28 se anclan al 28 para meses cortos) — el cupo es por MES aunque el
      // plan sea anual o el periodStart no haya rotado.
      const nowD = new Date();
      const anchor = s.periodStart ?? new Date(nowD.getFullYear(), nowD.getMonth(), 1);
      const anchorDay = Math.min(anchor.getDate(), 28);
      const periodStart = new Date(nowD.getFullYear(), nowD.getMonth(), anchorDay);
      if (periodStart > nowD) periodStart.setMonth(periodStart.getMonth() - 1);
      const activeRows = await admin.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(DISTINCT c.contact_id)::bigint AS n
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.organization_id = ${s.organizationId} AND m.created_at >= ${periodStart}`;
      const contactsInPeriod = Number(activeRows[0]?.n ?? 0);

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
