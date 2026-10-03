#!/usr/bin/env node
/**
 * Entorno SANDBOX de Conversia para que el planner recorra y pruebe TODO. Idempotente.
 * - Super admin sandbox (brand conversia) con MFA PRE-ENROLADA (secreto conocido → se pueden
 *   generar códigos sin escanear QR). Imprime el secreto + otpauth + un código válido ahora.
 * - Enriquece el tenant sandbox (ya registrado por API): plan conversia + suscripción activa +
 *   vigencia extendida + bolsa con créditos + contactos demo + caja demo (best-effort por sección).
 *
 * Uso (prod):
 *   railway run -s Postgres -- bash -c 'cd packages/database && DATABASE_URL="$DATABASE_PUBLIC_URL" \
 *     TENANT_ORG_ID="cmus94hyy0000l601w4xhl49b" node scripts/seed-sandbox.mjs'
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes, createHmac } from "node:crypto";

const prisma = new PrismaClient();
const BRAND = "conversia";
const ADMIN_EMAIL = "sandbox.admin@conversia.cl";
const ADMIN_PASSWORD = "SandboxAdmin-2026";
const ORG_ID = process.env.TENANT_ORG_ID || "";

// ---- base32 + TOTP (misma lógica que apps/api/src/platform/totp.ts) ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = s.replace(/=+$/,"").toUpperCase(); let bits = 0, val = 0; const out = [];
  for (const c of clean) { const idx = B32.indexOf(c); if (idx < 0) continue; val = (val << 5) | idx; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secretB32, forTime = Date.now()) {
  const counter = Math.floor(forTime / 1000 / 30);
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(b).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

async function seedSuperAdmin(role) {
  const secret = base32Encode(randomBytes(20));
  const existing = await prisma.platformAdmin.findUnique({ where: { email_brand: { email: ADMIN_EMAIL, brand: BRAND } } });
  const data = { passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 12), mfaSecret: secret, mfaEnabledAt: new Date(), role };
  let admin;
  if (existing) admin = await prisma.platformAdmin.update({ where: { id: existing.id }, data });
  else admin = await prisma.platformAdmin.create({ data: { email: ADMIN_EMAIL, brand: BRAND, name: "Super Admin Sandbox", ...data } });
  const otpauth = `otpauth://totp/${encodeURIComponent("Conversia:" + ADMIN_EMAIL)}?secret=${secret}&issuer=Conversia&algorithm=SHA1&digits=6&period=30`;
  console.log("\n===== SUPER ADMIN SANDBOX =====");
  console.log("  URL:        https://app.conversia.cl/admin/login");
  console.log("  Email:     ", ADMIN_EMAIL);
  console.log("  Password:  ", ADMIN_PASSWORD);
  console.log("  MFA secret:", secret, "(base32 — agrégalo a Google Authenticator/Authy, o úsalo en una lib TOTP)");
  console.log("  otpauth:   ", otpauth);
  console.log("  Código MFA ahora:", totp(secret), "(expira en ≤30s; genera uno nuevo con el secreto)");
}

async function enrichTenant() {
  if (!ORG_ID) { console.log("\n(TENANT_ORG_ID no seteado → omito enriquecer el tenant)"); return; }
  const org = await prisma.organization.findUnique({ where: { id: ORG_ID } });
  if (!org) { console.log(`\n✖ Org ${ORG_ID} no encontrada`); return; }
  console.log(`\n===== TENANT SANDBOX (${org.name}) =====`);

  // Plan conversia + suscripción activa + vigencia extendida (quita fricción de trial).
  try {
    const plan = await prisma.plan.findFirst({ where: { brand: BRAND, active: true }, orderBy: { order: "asc" } });
    const until = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    const settings = { ...(org.settings ?? {}), validUntil: until, conversia: { ...((org.settings ?? {}).conversia ?? {}), lifecycle: "active", setupPaid: true, deliveredAt: new Date().toISOString() } };
    await prisma.organization.update({ where: { id: ORG_ID }, data: { settings, ...(plan ? { planId: plan.id } : {}) } });
    if (plan) {
      const sub = await prisma.subscription.findFirst({ where: { organizationId: ORG_ID }, orderBy: { createdAt: "desc" } });
      const subData = { planId: plan.id, status: "ACTIVE", interval: "monthly", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 24 * 3600_000) };
      if (sub) await prisma.subscription.update({ where: { id: sub.id }, data: subData });
      else await prisma.subscription.create({ data: { organizationId: ORG_ID, ...subData } });
      console.log("  ✔ Plan:", plan.code, "+ suscripción ACTIVE + vigencia 1 año");
    } else console.log("  • Sin plan conversia activo → queda en trial");
  } catch (e) { console.log("  ✖ plan/suscripción:", e.message); }

  // Bolsa con créditos.
  try {
    await prisma.messageWallet.upsert({ where: { organizationId: ORG_ID }, create: { organizationId: ORG_ID, balance: 1500, includedPerPeriod: 1500, carryoverCap: 1500 }, update: { balance: 1500, includedPerPeriod: 1500 } });
    console.log("  ✔ Bolsa: 1.500 créditos");
  } catch (e) { console.log("  ✖ bolsa:", e.message); }

  // Contactos demo.
  try {
    const demo = [
      { firstName: "Camila", lastName: "Rojas", phone: "+56990000011" },
      { firstName: "Diego", lastName: "Fuentes", phone: "+56990000022" },
      { firstName: "Valentina", lastName: "Soto", phone: "+56990000033" },
      { firstName: "Matías", lastName: "Herrera", phone: "+56990000044" },
    ];
    let n = 0;
    for (const c of demo) {
      const ex = await prisma.contact.findFirst({ where: { organizationId: ORG_ID, phone: c.phone } });
      if (!ex) { await prisma.contact.create({ data: { organizationId: ORG_ID, ...c } }); n++; }
    }
    console.log(`  ✔ Contactos demo: ${n} creados (${demo.length} total)`);
  } catch (e) { console.log("  ✖ contactos:", e.message); }

  // Caja demo (append-only; postgres puede insertar).
  try {
    const entries = [
      { type: "ingreso", method: "efectivo", amount: 15000, concept: "Corte + barba", key: "sandbox-cash-1" },
      { type: "ingreso", method: "transferencia", amount: 22000, concept: "Corte + color", key: "sandbox-cash-2" },
      { type: "egreso", method: "efectivo", amount: 8000, concept: "Insumos", key: "sandbox-cash-3" },
    ];
    let n = 0;
    for (const e of entries) {
      const ex = await prisma.cashLedger.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ORG_ID, idempotencyKey: e.key } } }).catch(() => null);
      if (!ex) {
        await prisma.cashLedger.create({ data: { organizationId: ORG_ID, type: e.type, method: e.method, amount: e.type === "ingreso" ? e.amount : -e.amount, currency: "CLP", concept: e.concept, status: "declarado", createdById: "sandbox-seed", origin: "panel", idempotencyKey: e.key } });
        n++;
      }
    }
    console.log(`  ✔ Caja demo: ${n} asientos`);
  } catch (e) { console.log("  ✖ caja:", e.message); }
}

async function main() {
  // El super admin (grant de plataforma + MFA conocida) solo se crea con SEED_SUPERADMIN=1
  // y el ROL se controla con SANDBOX_ADMIN_ROLE (default "operador", restringido; "owner" = total).
  if (process.env.SEED_SUPERADMIN === "1") await seedSuperAdmin(process.env.SANDBOX_ADMIN_ROLE || "operador");
  else console.log("(super admin omitido — correr con SEED_SUPERADMIN=1 para crearlo)");
  await enrichTenant();
  console.log("\n✔ Sandbox listo.\n");
}
main().catch((e) => { console.error("✖", e.message); process.exit(1); }).finally(() => prisma.$disconnect());
