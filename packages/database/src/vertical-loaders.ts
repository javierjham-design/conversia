import type { Prisma } from "@prisma/client";

/**
 * LOADERS DE DATOS DE RUBRO (F2). Lógica de carga EXTRAÍDA de seed.ts para que la
 * reusen tanto el seed CLI como el instalador de paquetes verticales (apps/api). Cada
 * loader es idempotente (upsert por clave natural) y recibe el cliente Prisma activo
 * (el admin del seed o el `tx` del instalador transaccional). Solo cargan DATOS; el
 * "aplicar rubro" (horarios/vocabulario/módulos vía industries.ts) vive en el
 * instalador de apps/api, que sí puede importar esa capa.
 */

// Acepta tanto PrismaClient como un TransactionClient: ambos exponen los delegados.
export type DbClient = Prisma.TransactionClient;

export interface OrgMeta {
  timezone: string;
  currency: string;
}

export async function loadClinics(db: DbClient, orgId: string, items: any[] | undefined, orgTimezone: string): Promise<Record<string, string>> {
  const bySlug: Record<string, string> = {};
  for (const c of items ?? []) {
    const clinic = await db.clinic.upsert({
      where: { organizationId_slug: { organizationId: orgId, slug: c.slug } },
      update: { name: c.name, address: c.address, city: c.city },
      create: { organizationId: orgId, name: c.name, slug: c.slug, address: c.address, city: c.city, timezone: c.timezone ?? orgTimezone },
    });
    bySlug[c.slug] = clinic.id;
  }
  return bySlug;
}

export async function loadTeams(db: DbClient, orgId: string, items: any[] | undefined): Promise<void> {
  for (const t of items ?? []) {
    const existing = await db.team.findFirst({ where: { organizationId: orgId, name: t.name } });
    if (!existing) await db.team.create({ data: { organizationId: orgId, name: t.name, description: t.description } });
  }
}

export async function loadLeadStatuses(db: DbClient, orgId: string, items: any[] | undefined): Promise<void> {
  for (const s of items ?? []) {
    await db.leadStatus.upsert({
      where: { organizationId_code: { organizationId: orgId, code: s.code } },
      update: { name: s.name, category: s.category, order: s.order },
      create: { organizationId: orgId, code: s.code, name: s.name, category: s.category, order: s.order, system: true },
    });
  }
}

export async function loadServices(db: DbClient, orgId: string, items: any[] | undefined, currency: string): Promise<Record<string, string>> {
  const byCode: Record<string, string> = {};
  for (const s of items ?? []) {
    const svc = await db.service.upsert({
      where: { organizationId_code: { organizationId: orgId, code: s.code } },
      update: { name: s.name, price: s.price, durationMin: s.durationMin, category: s.category },
      create: { organizationId: orgId, code: s.code, name: s.name, category: s.category, durationMin: s.durationMin ?? 30, price: s.price, currency },
    });
    byCode[s.code] = svc.id;
  }
  return byCode;
}

export async function loadProfessionals(db: DbClient, orgId: string, items: any[] | undefined, clinicsBySlug: Record<string, string>, servicesByCode: Record<string, string>): Promise<void> {
  for (const p of items ?? []) {
    let prof = await db.professional.findFirst({ where: { organizationId: orgId, name: p.name } });
    if (!prof) {
      prof = await db.professional.create({
        data: { organizationId: orgId, clinicId: Object.values(clinicsBySlug)[0] ?? null, name: p.name, specialty: p.specialty },
      });
    }
    for (const code of p.services ?? []) {
      const serviceId = servicesByCode[code];
      if (!serviceId) continue;
      await db.professionalService.upsert({
        where: { organizationId_professionalId_serviceId: { organizationId: orgId, professionalId: prof.id, serviceId } },
        update: {},
        create: { organizationId: orgId, professionalId: prof.id, serviceId },
      });
    }
  }
}

export async function loadTags(db: DbClient, orgId: string, items: any[] | undefined): Promise<void> {
  for (const t of items ?? []) {
    await db.tag.upsert({
      where: { organizationId_name: { organizationId: orgId, name: t.name } },
      update: { color: t.color },
      create: { organizationId: orgId, name: t.name, color: t.color },
    });
  }
}

/**
 * Agentes del paquete. `publish` controla si la versión 1 queda PUBLISHED (seed) o
 * DRAFT (instalador de paquete vertical: el equipo/montaje publica tras personalizar).
 */
export async function loadAgents(db: DbClient, orgId: string, items: any[] | undefined, opts: { publish: boolean }): Promise<Record<string, string>> {
  const bySlug: Record<string, string> = {};
  for (const a of items ?? []) {
    const agent = await db.agent.upsert({
      where: { organizationId_slug: { organizationId: orgId, slug: a.slug } },
      update: { name: a.name, description: a.description, kind: a.kind },
      create: { organizationId: orgId, slug: a.slug, name: a.name, description: a.description, kind: a.kind ?? "custom" },
    });
    bySlug[a.slug] = agent.id;
    const status = opts.publish ? "PUBLISHED" : "DRAFT";
    let version = await db.agentVersion.findFirst({ where: { agentId: agent.id }, orderBy: { version: "desc" } });
    if (!version) {
      version = await db.agentVersion.create({
        data: {
          organizationId: orgId,
          agentId: agent.id,
          version: 1,
          status,
          systemPrompt: a.systemPrompt,
          config: a.config ?? {},
          tools: a.tools ?? [],
          publishedAt: opts.publish ? new Date() : null,
          changelog: opts.publish ? "Versión inicial (seed)" : "Versión inicial (paquete vertical, borrador)",
        },
      });
    }
    // Solo fijamos currentVersionId cuando la versión está publicada (borrador no "activa" el agente).
    if (opts.publish) await db.agent.update({ where: { id: agent.id }, data: { currentVersionId: version.id } });
  }
  return bySlug;
}

/**
 * Flujos del paquete. `publish` controla PUBLISHED (seed) o DRAFT (paquete vertical).
 */
export async function loadWorkflows(db: DbClient, orgId: string, items: any[] | undefined, opts: { publish: boolean }): Promise<void> {
  for (const w of items ?? []) {
    let wf = await db.workflow.findFirst({ where: { organizationId: orgId, templateKey: w.templateKey } });
    if (!wf) {
      wf = await db.workflow.create({
        data: { organizationId: orgId, name: w.name, description: w.description, templateKey: w.templateKey, active: opts.publish },
      });
    }
    let version = await db.workflowVersion.findFirst({ where: { workflowId: wf.id }, orderBy: { version: "desc" } });
    if (!version) {
      version = await db.workflowVersion.create({
        data: {
          organizationId: orgId,
          workflowId: wf.id,
          version: 1,
          status: opts.publish ? "PUBLISHED" : "DRAFT",
          definition: w.definition,
          publishedAt: opts.publish ? new Date() : null,
          changelog: opts.publish ? "Versión inicial (seed)" : "Versión inicial (paquete vertical, borrador)",
        },
      });
    }
    if (opts.publish) await db.workflow.update({ where: { id: wf.id }, data: { currentVersionId: version.id, active: true } });
  }
}

export async function loadKnowledge(db: DbClient, orgId: string, items: any[] | undefined): Promise<void> {
  for (const kb of items ?? []) {
    let base = await db.knowledgeBase.findFirst({ where: { organizationId: orgId, name: kb.baseName } });
    if (!base) base = await db.knowledgeBase.create({ data: { organizationId: orgId, name: kb.baseName } });
    for (const d of kb.documents ?? []) {
      const doc = await db.knowledgeDocument.findFirst({ where: { baseId: base.id, title: d.title } });
      if (!doc) {
        await db.knowledgeDocument.create({
          data: { organizationId: orgId, baseId: base.id, title: d.title, sourceType: d.sourceType ?? "text", status: "PUBLISHED", content: d.content },
        });
      }
    }
  }
}

export async function loadChannel(db: DbClient, orgId: string, channel: any | undefined, agentsBySlug: Record<string, string>): Promise<void> {
  if (!channel) return;
  const existing = await db.channelConnection.findFirst({ where: { organizationId: orgId, name: channel.name } });
  if (!existing) {
    await db.channelConnection.create({
      data: { organizationId: orgId, type: channel.type, name: channel.name, defaultAgentId: agentsBySlug[channel.defaultAgentSlug] ?? null },
    });
  }
}

/**
 * Carga TODO el bloque de datos de un rubro (orden que respeta dependencias). La usan
 * el seed (publish=true) y el instalador de paquetes verticales (publish=false →
 * agentes/flujos quedan en borrador). NO aplica horarios/vocabulario/módulos: eso lo
 * hace el instalador con industries.ts (ver apps/api).
 */
export async function loadVerticalData(db: DbClient, orgId: string, orgMeta: OrgMeta, data: any, opts: { publish: boolean }): Promise<void> {
  const clinicsBySlug = await loadClinics(db, orgId, data.clinics, orgMeta.timezone);
  await loadTeams(db, orgId, data.teams);
  await loadLeadStatuses(db, orgId, data.leadStatuses);
  const servicesByCode = await loadServices(db, orgId, data.services, orgMeta.currency);
  await loadProfessionals(db, orgId, data.professionals, clinicsBySlug, servicesByCode);
  await loadTags(db, orgId, data.tags);
  const agentsBySlug = await loadAgents(db, orgId, data.agents, opts);
  await loadWorkflows(db, orgId, data.workflows, opts);
  await loadKnowledge(db, orgId, data.knowledge);
  await loadChannel(db, orgId, data.channel, agentsBySlug);
}
