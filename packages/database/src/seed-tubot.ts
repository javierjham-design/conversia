/**
 * Siembra dirigida del tenant comercial de TuBot (seeds/tubot.json +
 * seeds/tubot-prompts/*.md). A diferencia del seed general, este script:
 *   - NUNCA crea la organización: exige que exista (slug `tubot` o
 *     TUBOT_ORG_SLUG; fallback por membresía del admin del JSON). Así no se
 *     puede duplicar el tenant productivo por accidente.
 *   - SÍ actualiza prompts ya publicados: si el prompt/config/tools de un
 *     agente cambió, publica una versión NUEVA (n+1) y apunta currentVersionId,
 *     igual que el flujo Guardar → Publicar de la app. Si no cambió, no toca.
 * Uso: pnpm --filter @conversia/database seed:tubot   (DATABASE_URL admin)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPrisma } from "./index.js";

const prisma = getPrisma();

type AgentSeed = {
  slug: string;
  name: string;
  kind: string;
  description?: string;
  promptFile: string;
  tools: string[];
  config: Record<string, unknown>;
};

type TubotSeed = {
  organization: { slug: string };
  fallbackAdminEmail?: string;
  leadStatuses?: { code: string; name: string; category: string; order: number }[];
  tags?: { name: string; color?: string }[];
  agents: AgentSeed[];
};

const SEEDS_DIR = join(__dirname, "..", "seeds");

async function resolveOrganization(seed: TubotSeed) {
  const slug = process.env.TUBOT_ORG_SLUG ?? seed.organization.slug;
  const bySlug = await prisma.organization.findUnique({ where: { slug } });
  if (bySlug) return bySlug;

  if (seed.fallbackAdminEmail) {
    const membership = await prisma.organizationUser.findFirst({
      where: { user: { email: seed.fallbackAdminEmail } },
    });
    if (membership) {
      const org = await prisma.organization.findUnique({ where: { id: membership.organizationId } });
      if (org) {
        console.log(`ℹ Slug "${slug}" no existe; usando la organización de ${seed.fallbackAdminEmail}: ${org.slug}`);
        return org;
      }
    }
  }

  const available = await prisma.organization.findMany({ select: { slug: true, name: true }, orderBy: { createdAt: "asc" } });
  console.error(`✖ No existe una organización con slug "${slug}" ni membresía de ${seed.fallbackAdminEmail ?? "(sin fallback)"}.`);
  console.error(`  Organizaciones disponibles: ${available.map((o) => `${o.slug} (${o.name})`).join(", ") || "ninguna"}`);
  console.error(`  Define TUBOT_ORG_SLUG con el slug correcto y reintenta. Este script no crea organizaciones.`);
  process.exit(1);
}

function normalizedEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const seed: TubotSeed = JSON.parse(readFileSync(join(SEEDS_DIR, "tubot.json"), "utf-8"));
  const org = await resolveOrganization(seed);
  console.log(`✔ Tenant TuBot: ${org.name} (${org.id}, slug ${org.slug})`);

  for (const s of seed.leadStatuses ?? []) {
    await prisma.leadStatus.upsert({
      where: { organizationId_code: { organizationId: org.id, code: s.code } },
      update: { name: s.name, category: s.category as any, order: s.order },
      create: { organizationId: org.id, code: s.code, name: s.name, category: s.category as any, order: s.order, system: true },
    });
  }
  if (seed.leadStatuses?.length) console.log(`✔ Embudo: ${seed.leadStatuses.map((s) => s.code).join(" → ")}`);

  for (const t of seed.tags ?? []) {
    await prisma.tag.upsert({
      where: { organizationId_name: { organizationId: org.id, name: t.name } },
      update: { color: t.color },
      create: { organizationId: org.id, name: t.name, color: t.color },
    });
  }
  if (seed.tags?.length) console.log(`✔ Etiquetas: ${seed.tags.length}`);

  for (const a of seed.agents) {
    const systemPrompt = readFileSync(join(SEEDS_DIR, a.promptFile), "utf-8").trim();
    const agent = await prisma.agent.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: a.slug } },
      update: { name: a.name, description: a.description, kind: a.kind, active: true },
      create: { organizationId: org.id, slug: a.slug, name: a.name, description: a.description, kind: a.kind, active: true },
    });

    const latest = await prisma.agentVersion.findFirst({ where: { agentId: agent.id }, orderBy: { version: "desc" } });
    const current = agent.currentVersionId
      ? await prisma.agentVersion.findUnique({ where: { id: agent.currentVersionId } })
      : latest?.status === "PUBLISHED"
        ? latest
        : null;

    const unchanged =
      current?.status === "PUBLISHED" &&
      current.systemPrompt.trim() === systemPrompt &&
      normalizedEqual(current.tools, a.tools) &&
      normalizedEqual(current.config, a.config);
    if (unchanged) {
      console.log(`· Agente ${a.slug}: sin cambios (v${current!.version})`);
      continue;
    }

    const version = await prisma.agentVersion.create({
      data: {
        organizationId: org.id,
        agentId: agent.id,
        version: (latest?.version ?? 0) + 1,
        status: "PUBLISHED",
        systemPrompt,
        config: a.config as any,
        tools: a.tools as any,
        publishedAt: new Date(),
        changelog: "Actualización comercial: registro autoservicio, checkout online y asistente de implementación (seed:tubot)",
      },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { currentVersionId: version.id } });
    console.log(`✔ Agente ${a.slug}: publicada v${version.version}${current ? ` (antes v${current.version})` : " (primera versión)"}`);
  }

  console.log("✔ Listo. Verifica en la app: Agentes → probador, antes de atender tráfico real.");
}

main()
  .catch((err) => {
    console.error("✖ seed:tubot falló:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
