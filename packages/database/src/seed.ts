/**
 * Seed de plataforma + tenants desde archivos JSON (seeds/*.json).
 * Digital Dent es un tenant más: mismo código para cualquier cliente.
 * Ejecutar con conexión admin: pnpm db:seed
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as bcryptMod from "bcryptjs";
import { getPrisma } from "./index.js";

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

  // Sedes
  const clinicsBySlug: Record<string, string> = {};
  for (const c of seed.clinics ?? []) {
    const clinic = await prisma.clinic.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: c.slug } },
      update: { name: c.name, address: c.address, city: c.city },
      create: {
        organizationId: org.id,
        name: c.name,
        slug: c.slug,
        address: c.address,
        city: c.city,
        timezone: c.timezone ?? org.timezone,
      },
    });
    clinicsBySlug[c.slug] = clinic.id;
  }

  // Equipos
  for (const t of seed.teams ?? []) {
    const existing = await prisma.team.findFirst({ where: { organizationId: org.id, name: t.name } });
    if (!existing) {
      await prisma.team.create({
        data: { organizationId: org.id, name: t.name, description: t.description },
      });
    }
  }

  // Estados de lead
  for (const s of seed.leadStatuses ?? []) {
    await prisma.leadStatus.upsert({
      where: { organizationId_code: { organizationId: org.id, code: s.code } },
      update: { name: s.name, category: s.category, order: s.order },
      create: {
        organizationId: org.id,
        code: s.code,
        name: s.name,
        category: s.category,
        order: s.order,
        system: true,
      },
    });
  }

  // Servicios
  const servicesByCode: Record<string, string> = {};
  for (const s of seed.services ?? []) {
    const svc = await prisma.service.upsert({
      where: { organizationId_code: { organizationId: org.id, code: s.code } },
      update: { name: s.name, price: s.price, durationMin: s.durationMin, category: s.category },
      create: {
        organizationId: org.id,
        code: s.code,
        name: s.name,
        category: s.category,
        durationMin: s.durationMin ?? 30,
        price: s.price,
        currency: org.currency,
      },
    });
    servicesByCode[s.code] = svc.id;
  }

  // Profesionales + servicios que atienden
  for (const p of seed.professionals ?? []) {
    let prof = await prisma.professional.findFirst({ where: { organizationId: org.id, name: p.name } });
    if (!prof) {
      prof = await prisma.professional.create({
        data: {
          organizationId: org.id,
          clinicId: Object.values(clinicsBySlug)[0] ?? null,
          name: p.name,
          specialty: p.specialty,
        },
      });
    }
    for (const code of p.services ?? []) {
      const serviceId = servicesByCode[code];
      if (!serviceId) continue;
      await prisma.professionalService.upsert({
        where: {
          organizationId_professionalId_serviceId: {
            organizationId: org.id,
            professionalId: prof.id,
            serviceId,
          },
        },
        update: {},
        create: { organizationId: org.id, professionalId: prof.id, serviceId },
      });
    }
  }

  // Etiquetas
  for (const t of seed.tags ?? []) {
    await prisma.tag.upsert({
      where: { organizationId_name: { organizationId: org.id, name: t.name } },
      update: { color: t.color },
      create: { organizationId: org.id, name: t.name, color: t.color },
    });
  }

  // Agentes con versión 1 publicada
  const agentsBySlug: Record<string, string> = {};
  for (const a of seed.agents ?? []) {
    const agent = await prisma.agent.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: a.slug } },
      update: { name: a.name, description: a.description, kind: a.kind },
      create: {
        organizationId: org.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        kind: a.kind ?? "custom",
      },
    });
    agentsBySlug[a.slug] = agent.id;
    let version = await prisma.agentVersion.findFirst({
      where: { agentId: agent.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    if (!version) {
      version = await prisma.agentVersion.create({
        data: {
          organizationId: org.id,
          agentId: agent.id,
          version: 1,
          status: "PUBLISHED",
          systemPrompt: a.systemPrompt,
          config: a.config ?? {},
          tools: a.tools ?? [],
          publishedAt: new Date(),
          changelog: "Versión inicial (seed)",
        },
      });
    }
    await prisma.agent.update({ where: { id: agent.id }, data: { currentVersionId: version.id } });
  }

  // Workflows con versión 1 publicada
  for (const w of seed.workflows ?? []) {
    let wf = await prisma.workflow.findFirst({ where: { organizationId: org.id, templateKey: w.templateKey } });
    if (!wf) {
      wf = await prisma.workflow.create({
        data: {
          organizationId: org.id,
          name: w.name,
          description: w.description,
          templateKey: w.templateKey,
          active: true,
        },
      });
    }
    let version = await prisma.workflowVersion.findFirst({
      where: { workflowId: wf.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    if (!version) {
      version = await prisma.workflowVersion.create({
        data: {
          organizationId: org.id,
          workflowId: wf.id,
          version: 1,
          status: "PUBLISHED",
          definition: w.definition,
          publishedAt: new Date(),
          changelog: "Versión inicial (seed)",
        },
      });
    }
    await prisma.workflow.update({ where: { id: wf.id }, data: { currentVersionId: version.id, active: true } });
  }

  // Base de conocimiento (documentos sin embeddings; se indexan aparte)
  for (const kb of seed.knowledge ?? []) {
    let base = await prisma.knowledgeBase.findFirst({ where: { organizationId: org.id, name: kb.baseName } });
    if (!base) {
      base = await prisma.knowledgeBase.create({
        data: { organizationId: org.id, name: kb.baseName },
      });
    }
    for (const d of kb.documents ?? []) {
      const doc = await prisma.knowledgeDocument.findFirst({ where: { baseId: base.id, title: d.title } });
      if (!doc) {
        await prisma.knowledgeDocument.create({
          data: {
            organizationId: org.id,
            baseId: base.id,
            title: d.title,
            sourceType: d.sourceType ?? "text",
            status: "PUBLISHED",
            content: d.content,
          },
        });
      }
    }
  }

  // Canal (MOCK en dev; WHATSAPP_CLOUD al conectar Meta)
  if (seed.channel) {
    const existing = await prisma.channelConnection.findFirst({
      where: { organizationId: org.id, name: seed.channel.name },
    });
    if (!existing) {
      await prisma.channelConnection.create({
        data: {
          organizationId: org.id,
          type: seed.channel.type,
          name: seed.channel.name,
          defaultAgentId: agentsBySlug[seed.channel.defaultAgentSlug] ?? null,
        },
      });
    }
  }

  return org;
}

async function main() {
  // Plan por defecto de la plataforma
  await prisma.plan.upsert({
    where: { code: "starter" },
    update: {},
    create: {
      code: "starter",
      name: "Starter",
      limits: { users: 5, clinics: 2, channels: 1, agents: 5, workflows: 10, aiTokensMonthly: 5_000_000 },
      features: { whiteLabel: false, api: true },
      priceUsd: 0,
    },
  });

  await seedTenant("digital-dent.json", "admin@digital-dent.local");
  await seedTenant("demo-clinic.json", "admin@clinica-demo.local");

  console.log("✔ Seed completo (2 tenants). Aislamiento verificable entre ambos.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
