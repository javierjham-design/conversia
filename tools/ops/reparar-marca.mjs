#!/usr/bin/env node
/**
 * reparar-marca.mjs — Corrige orgs que NACIERON con marca `tubot` por error desde el funnel
 * de Conversia (bug pre-#506: registrarse desde `conversia.cl` apex creaba la cuenta en TuBot,
 * con catálogo, plan de prueba y asistente equivocados; el asistente les respondía "(Not Found)").
 *
 * QUÉ HACE (por cada org candidata), replicando el camino V2 de registro
 * (apps/api/src/auth/auth.service.ts:55-268):
 *   1. organizations.brand            : 'tubot' → 'conversia'
 *   2. organizations.plan_id          : → id de `conversia_v2_trial`
 *   3. organizations.settings.conversia: { lifecycle: 'v2_trial', accent: <por país> }  (merge)
 *   4. users.brand (dueño/miembros)   : 'tubot' → 'conversia'  ← SIN esto el dueño NO puede
 *                                        loguear en conversia-web (login resuelve por email+marca)
 *   5. subscription                   : TRIALING → conversia_v2_trial (+60 días) si no la tiene
 *   6. regalo de 30 conversaciones    : lot(bonus,30) + ledger(+30), idempotente por signup_gift
 *   7. audit_logs                     : asiento 'organization.brand_repair' (before/after)
 *
 * HEURÍSTICA de candidatas (orgs brand='tubot' que vienen del funnel Conversia):
 *   - email del dueño en dominios/patrones de prueba (qa+…, @conversia.local, @pushload.local), o
 *   - `settings.vertical` presente o subárbol `settings.conversia` presente, o
 *   - un evento de funnel `registered` (integration_events provider=funnel) en la org.
 *   (NUNCA toca las orgs TuBot reales: digital-dent / clinica-demo NO caen en la heurística.)
 *
 * SEGURIDAD:
 *   - DRY-RUN POR DEFECTO: solo lista; no muta nada.
 *   - `--apply` exige además `--all` (todas las candidatas) o `--ids=a,b` / `--emails=x,y`
 *     (subconjunto REVISADO). Sin eso, se niega. (Regla dura: --apply solo con la lista revisada.)
 *   - TuBot intacto; nada destructivo.
 *
 * CONEXIÓN: Prisma sobre `DATABASE_URL` (superusuario → bypassa RLS, como los otros scripts ops).
 *   SIM:  DATABASE_URL=postgresql://postgres:postgres@localhost:5433/conversia_sim \
 *           node tools/ops/reparar-marca.mjs                 # dry-run
 *   PROD: railway run -s Postgres -- bash -c \
 *           'DATABASE_URL="$DATABASE_PUBLIC_URL" node tools/ops/reparar-marca.mjs'            # dry-run
 *         railway run -s Postgres -- bash -c \
 *           'DATABASE_URL="$DATABASE_PUBLIC_URL" node tools/ops/reparar-marca.mjs --apply --ids=org_a,org_b'
 *
 * Node >=18, ESM. Resuelve @prisma/client desde packages/database (pnpm no lo hoistea a tools/).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbRequire = createRequire(join(ROOT, "packages/database/package.json"));
const { PrismaClient } = dbRequire("@prisma/client");

// ───────────────────────── CLI ─────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const a = argv.find((x) => x.startsWith(`${f}=`));
  return a ? a.slice(f.length + 1) : null;
};
const APPLY = has("--apply");
const ALL = has("--all");
const ONLY_IDS = (val("--ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_EMAILS = (val("--emails") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const TRIAL_PLAN_CODE = "conversia_v2_trial";

// Acento por país (replica packages/config accentForCountry; mapa estable, sin build).
const ACCENT_BY_COUNTRY = { CL: "menta", AR: "artico", CO: "oro", MX: "lima", PE: "coral" };
const accentForCountry = (c) => {
  const k = (c || "").toUpperCase();
  if (!k) return "menta";
  return ACCENT_BY_COUNTRY[k] ?? "indigo";
};

// ───────────────────────── Heurística ─────────────────────────
/** Dominios/patrones de prueba de Javier/QA. Excluye adrede digital-dent/clinica-demo (TuBot real). */
function isTestEmail(email) {
  const e = (email || "").toLowerCase();
  if (!e.includes("@")) return false;
  const [local, domain] = e.split("@");
  if (local.startsWith("qa+")) return true; // qa+<fecha>@conversia.cl / @conversia.local
  return ["conversia.local", "pushload.local"].includes(domain);
}

const C = (() => {
  const on = process.stdout.isTTY && !process.env.NO_COLOR;
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { green: w(32), red: w(31), yellow: w(33), gray: w(90), bold: w(1), cyan: w(36) };
})();

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(C.red("Falta DATABASE_URL. Ver cabecera del script para SIM/PROD."));
    process.exit(2);
  }
  // Guardas de seguridad para --apply.
  if (APPLY && !ALL && ONLY_IDS.length === 0 && ONLY_EMAILS.length === 0) {
    console.error(
      C.red("\n--apply requiere una lista REVISADA: pasa --ids=a,b,c o --emails=x,y (recomendado),\n") +
        C.red("o --all para TODAS las candidatas del dry-run. Corre primero sin --apply y revisa.\n"),
    );
    process.exit(2);
  }

  console.log(C.bold(`\n🔧 reparar-marca — ${APPLY ? C.red("APPLY (muta datos)") : C.green("DRY-RUN (solo lista)")}`));
  console.log(C.gray(`   DB=${(process.env.DATABASE_URL || "").replace(/:[^:@/]*@/, ":***@")}\n`));

  const trialPlan = await prisma.plan.findUnique({ where: { code: TRIAL_PLAN_CODE }, select: { id: true, code: true } });
  if (!trialPlan) {
    console.error(C.red(`No existe el plan ${TRIAL_PLAN_CODE}. ¿Corriste el catálogo V2 (v2-golive / seed-conversia-catalog)?`));
    process.exit(2);
  }

  // Todas las orgs tubot + dueño + señales.
  const tubotOrgs = await prisma.organization.findMany({
    where: { brand: "tubot" },
    select: { id: true, name: true, slug: true, brand: true, planId: true, settings: true, country: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const candidates = [];
  for (const org of tubotOrgs) {
    // Dueño (rol owner) y, si no, cualquier miembro. (OrganizationUser expone roleId, no la
    // relación role → resolvemos el código del rol aparte.)
    const members = await prisma.organizationUser.findMany({
      where: { organizationId: org.id },
      select: { user: { select: { id: true, email: true, brand: true } }, roleId: true },
    });
    const roles = await prisma.role.findMany({ where: { organizationId: org.id }, select: { id: true, code: true } });
    const roleCode = (id) => roles.find((r) => r.id === id)?.code ?? null;
    const owner = members.find((m) => roleCode(m.roleId) === "owner") ?? members[0];
    const ownerEmail = owner?.user?.email ?? "(sin dueño)";

    const funnel = await prisma.integrationEvent.findFirst({
      where: { organizationId: org.id, provider: "funnel", type: "registered" },
      select: { id: true, payload: true },
    });

    const settings = (org.settings && typeof org.settings === "object" ? org.settings : {}) || {};
    const reasons = [];
    if (isTestEmail(ownerEmail)) reasons.push("email-prueba");
    if (settings.vertical) reasons.push("settings.vertical");
    if (settings.conversia) reasons.push("settings.conversia");
    if (funnel) reasons.push("funnel.registered");

    // Inclusión explícita por --ids/--emails (aunque no dispare la heurística).
    const forcedById = ONLY_IDS.includes(org.id);
    const forcedByEmail = ONLY_EMAILS.includes(ownerEmail.toLowerCase());
    if (forcedById || forcedByEmail) reasons.push("explícito");

    if (reasons.length === 0) continue; // no es candidata

    candidates.push({ org, members, owner, ownerEmail, funnelVertical: funnel?.payload?.vertical ?? null, reasons });
  }

  // Subconjunto objetivo según flags.
  const targets = candidates.filter((c) => {
    if (ONLY_IDS.length || ONLY_EMAILS.length) return ONLY_IDS.includes(c.org.id) || ONLY_EMAILS.includes(c.ownerEmail.toLowerCase());
    return true; // --all o dry-run → todas las candidatas
  });

  if (candidates.length === 0) {
    console.log(C.green("No se encontraron orgs tubot mal nacidas desde el funnel Conversia. Nada que hacer.\n"));
    await prisma.$disconnect();
    return;
  }

  console.log(C.bold(`Candidatas (${candidates.length}) · objetivo de esta corrida (${targets.length}):\n`));
  for (const c of candidates) {
    const sel = targets.includes(c) ? C.cyan("▶") : C.gray("·");
    console.log(
      `  ${sel} ${C.bold(c.org.id)}  ${C.gray(c.org.createdAt.toISOString().slice(0, 10))}  ${c.ownerEmail}  "${c.org.name}" [${c.org.country}]  ${C.yellow(c.reasons.join(","))}`,
    );
  }
  console.log("");

  if (!APPLY) {
    console.log(C.green("DRY-RUN: no se cambió nada.") + C.gray(" Revisa la lista y corre con --apply --ids=… (o --all).\n"));
    await prisma.$disconnect();
    return;
  }

  // ───────────────────────── APPLY ─────────────────────────
  const summary = { repaired: 0, skipped: [] };
  for (const c of targets) {
    const { org, members, ownerEmail } = c;
    try {
      // timeout alto: contra prod vía proxy la latencia por consulta es mayor y la transacción
      // interactiva (varias consultas) supera los 5s por defecto de Prisma → "Transaction not found".
      await prisma.$transaction(async (tx) => {
        // 4) users.brand → conversia (sin esto el login desde conversia-web no encuentra la cuenta).
        //    Detecta colisión con un usuario conversia ya existente del mismo email.
        for (const m of members) {
          const u = m.user;
          if (!u || u.brand === "conversia") continue;
          const clash = await tx.user.findUnique({ where: { email_brand: { email: u.email, brand: "conversia" } }, select: { id: true } });
          if (clash) throw new Error(`colisión: ya existe un usuario conversia con el email ${u.email}; revisar a mano`);
          await tx.user.update({
            where: { id: u.id },
            data: { brand: "conversia", settings: { accent: accentForCountry(org.country) } },
          });
        }

        // 1/2/3) organizations: brand, plan, settings.conversia (merge sin pisar otras llaves).
        const prevSettings = (org.settings && typeof org.settings === "object" ? org.settings : {}) || {};
        const newSettings = { ...prevSettings, conversia: { ...(prevSettings.conversia || {}), lifecycle: "v2_trial", accent: accentForCountry(org.country) } };
        await tx.organization.update({
          where: { id: org.id },
          data: { brand: "conversia", planId: trialPlan.id, settings: newSettings },
        });

        // 5) suscripción TRIALING al plan de prueba (+60d). Reusa la activa si existe; si no, crea.
        const now = new Date();
        const periodEnd = new Date(now.getTime() + 60 * 86_400_000);
        const existingSub = await tx.subscription.findFirst({
          where: { organizationId: org.id, status: { in: ["TRIALING", "ACTIVE", "PAST_DUE"] } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (existingSub) {
          await tx.subscription.update({ where: { id: existingSub.id }, data: { planId: trialPlan.id, status: "TRIALING", interval: "monthly", periodStart: now, periodEnd } });
        } else {
          await tx.subscription.create({ data: { organizationId: org.id, planId: trialPlan.id, status: "TRIALING", interval: "monthly", periodStart: now, periodEnd } });
        }

        // 6) regalo de 30 conversaciones, idempotente por refType=signup_gift.
        const refId = `signup:${org.id}`;
        const dup = await tx.conversationCreditLedger.findFirst({ where: { organizationId: org.id, refType: "signup_gift" }, select: { id: true } });
        if (!dup) {
          const expiresAt = new Date(now.getTime() + 60 * 86_400_000);
          await tx.conversationWallet.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, periodStart: new Date(0) }, update: {} });
          await tx.conversationCreditLot.create({ data: { organizationId: org.id, source: "bonus", amount: 30, remaining: 30, expiresAt, refType: "signup_gift", refId } });
          await tx.conversationCreditLedger.create({ data: { organizationId: org.id, delta: 30, reason: "admin_adjust", balanceAfter: 30, refType: "signup_gift", refId } });
        }

        // 7) auditoría.
        await tx.auditLog.create({
          data: {
            organizationId: org.id,
            actorType: "system",
            action: "organization.brand_repair",
            entityType: "organization",
            entityId: org.id,
            before: { brand: "tubot", planId: org.planId },
            after: { brand: "conversia", planId: trialPlan.id, lifecycle: "v2_trial", giftGranted: !dup },
          },
        });
      }, { maxWait: 15_000, timeout: 60_000 });
      summary.repaired += 1;
      console.log(`  ${C.green("✓")} ${org.id}  ${ownerEmail}  reparada → conversia + v2_trial + 30`);
    } catch (e) {
      summary.skipped.push({ id: org.id, email: ownerEmail, reason: e.message });
      console.log(`  ${C.red("✗")} ${org.id}  ${ownerEmail}  OMITIDA: ${e.message}`);
    }
  }

  console.log(C.bold(`\nResumen: ${C.green(summary.repaired + " reparadas")} · ${C.red(summary.skipped.length + " omitidas")}\n`));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(C.red(`Error fatal: ${e.stack || e.message}`));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
