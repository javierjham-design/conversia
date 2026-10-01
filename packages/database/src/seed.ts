/**
 * Seed de plataforma + tenants desde archivos JSON (seeds/*.json).
 * Digital Dent es un tenant más: mismo código para cualquier cliente.
 * Ejecutar con conexión admin: pnpm db:seed
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as bcryptMod from "bcryptjs";
import { getPrisma } from "./index.js";
import { loadVerticalData } from "./vertical-loaders.js";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;
const prisma = getPrisma();

const DEFAULT_ROLES = [
  { code: "owner", name: "Propietario", permissions: ["*"] },
  { code: "admin", name: "Administrador", permissions: ["*"] },
  {
    code: "supervisor",
    name: "Supervisor",
    permissions: ["inbox:*", "contacts:*", "leads:*", "reports:read", "agents:read", "workflows:read"],
  },
  {
    code: "operator",
    name: "Operador",
    permissions: ["inbox:read", "inbox:write", "contacts:read", "contacts:write", "leads:read", "leads:write"],
  },
  { code: "viewer", name: "Solo lectura", permissions: ["inbox:read", "contacts:read", "leads:read", "reports:read"] },
] as const;

type TenantSeed = any;

async function seedTenant(fileName: string, adminEmail: string) {
  const raw = readFileSync(join(__dirname, "..", "seeds", fileName), "utf-8");
  const seed: TenantSeed = JSON.parse(raw);
  const orgData = seed.organization;

  const org = await prisma.organization.upsert({
    where: { slug: orgData.slug },
    update: { name: orgData.name, settings: orgData.settings ?? {} },
    create: {
      name: orgData.name,
      slug: orgData.slug,
      status: "ACTIVE",
      country: orgData.country ?? "CL",
      timezone: orgData.timezone ?? "America/Santiago",
      locale: orgData.locale ?? "es",
      currency: orgData.currency ?? "CLP",
      settings: orgData.settings ?? {},
    },
  });
  console.log(`✔ Organización ${org.name} (${org.id})`);

  // Roles del sistema
  for (const r of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { organizationId_code: { organizationId: org.id, code: r.code } },
      update: { permissions: r.permissions as any },
      create: {
        organizationId: org.id,
        code: r.code,
        name: r.name,
        permissions: r.permissions as any,
        system: true,
      },
    });
  }
  const ownerRole = await prisma.role.findUniqueOrThrow({
    where: { organizationId_code: { organizationId: org.id, code: "owner" } },
  });

  // Usuario administrador del tenant
  const password = process.env.SEED_ADMIN_PASSWORD ?? "conversia-dev";
  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: bcrypt.hashSync(password, 10),
      name: `Admin ${org.name}`,
    },
  });
  await prisma.organizationUser.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { roleId: ownerRole.id },
    create: { organizationId: org.id, userId: user.id, roleId: ownerRole.id },
  });
  console.log(`✔ Usuario admin ${adminEmail} (password: valor de SEED_ADMIN_PASSWORD o 'conversia-dev')`);

  // Datos del tenant (sedes, equipos, estados, servicios, profesionales, etiquetas,
  // agentes, flujos, conocimiento, canal). Loaders compartidos con el instalador de
  // paquetes verticales (F2); en el seed se publican (publish:true).
  await loadVerticalData(
    prisma as unknown as import("./vertical-loaders.js").DbClient,
    org.id,
    { timezone: org.timezone, currency: org.currency },
    seed,
    { publish: true },
  );

  return org;
}

const PLANS = [
  {
    code: "free",
    name: "Free",
    priceClp: 0,
    priceUsd: 0,
    order: 0,
    limits: { users: 2, clinics: 1, channels: 1, agents: 2, workflows: 3, aiTokensDaily: 200_000 },
    // templateMessages = cupo de la bolsa prepagada/mes (-1 = ilimitado). El
    // excedente se compra por paquetes prepago (no hay cobro post-pago).
    // whatsappTemplates = capacidad de mensajes de plantilla: los planes básicos
    // (Free) NO la incluyen, independiente del switch por-tenant.
    // conversationsPerPeriod: cupo mensual de conversaciones (0 = solo medición, sin
    // avisos ni topes; -1 = ilimitado; N>0 = cupo). Convención PROPIA (E3), distinta
    // de templateMessages (donde 0 bloquea). Números reales los siembra el dueño con
    // la cifra del bloque 1. conversationOverageClp: CLP por conversación extra (0 =
    // no facturar overage). conversationHardCap: corta al 100% (true) vs. tope blando.
    features: { whiteLabel: false, api: false, templateMessages: 0, whatsappTemplates: false, conversationsPerPeriod: 0, conversationOverageClp: 0, conversationHardCap: true },
  },
  {
    code: "starter",
    name: "Starter",
    priceClp: 69_900,
    priceUsd: 75,
    order: 1,
    limits: { users: 5, clinics: 2, channels: 1, agents: 5, workflows: 10, aiTokensDaily: 1_000_000 },
    features: { whiteLabel: false, api: true, templateMessages: 1000, whatsappTemplates: true, conversationsPerPeriod: 0, conversationOverageClp: 0, conversationHardCap: false },
  },
  {
    code: "pro",
    name: "Pro",
    priceClp: 119_900,
    priceUsd: 129,
    order: 2,
    limits: { users: 20, clinics: 5, channels: 3, agents: 20, workflows: 50, aiTokensDaily: 5_000_000 },
    features: { whiteLabel: true, api: true, templateMessages: 1500, whatsappTemplates: true, conversationsPerPeriod: 0, conversationOverageClp: 0, conversationHardCap: false },
  },
  {
    code: "enterprise",
    name: "Enterprise",
    priceClp: 0,
    priceUsd: 0,
    order: 3,
    isPublic: false,
    limits: { users: 0, clinics: 0, channels: 0, agents: 0, workflows: 0, aiTokensDaily: 0 }, // 0 = ilimitado
    features: { whiteLabel: true, api: true, sso: true, templateMessages: 4000, whatsappTemplates: true, conversationsPerPeriod: 0, conversationOverageClp: 0, conversationHardCap: false },
  },
];

async function main() {
  // Catálogo de planes de la plataforma
  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, priceClp: p.priceClp, priceUsd: p.priceUsd, order: p.order, limits: p.limits, features: p.features, isPublic: p.isPublic ?? true },
      create: p as any,
    });
  }

  // Catálogo de PAQUETES VERTICALES (globales, organizationId NULL). Idempotente por
  // (key, version). Los instala el motor de F2 en cada tenant (borrador editable).
  const verticalsRaw = readFileSync(join(__dirname, "..", "seeds", "vertical-templates.json"), "utf-8");
  const verticals = JSON.parse(verticalsRaw) as Array<{ key: string; version: number; name: string; definition: any }>;
  for (const v of verticals) {
    await prisma.verticalTemplate.upsert({
      where: { key_version: { key: v.key, version: v.version } },
      update: { name: v.name, definition: v.definition, active: true },
      create: { key: v.key, version: v.version, name: v.name, definition: v.definition, active: true },
    });
  }
  console.log(`✔ ${verticals.length} paquetes verticales (dental, barberia, generico).`);

  // Administrador de PLATAFORMA (super-admin). Identidad separada de los tenants.
  const platformPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? "conversia-platform-dev";
  const platformEmail = process.env.PLATFORM_ADMIN_EMAIL ?? "superadmin@conversia.local";
  await prisma.platformAdmin.upsert({
    where: { email: platformEmail },
    update: {},
    create: { email: platformEmail, name: "Super Admin", passwordHash: bcrypt.hashSync(platformPassword, 12) },
  });
  console.log(`✔ Admin de plataforma ${platformEmail} (password: valor de PLATFORM_ADMIN_PASSWORD o 'conversia-platform-dev')`);

  await seedTenant("digital-dent.json", "admin@digital-dent.local");
  await seedTenant("demo-clinic.json", "admin@clinica-demo.local");

  console.log("✔ Seed completo (4 planes + super-admin + 2 tenants).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
