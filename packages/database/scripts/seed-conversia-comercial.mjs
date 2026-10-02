#!/usr/bin/env node
/**
 * TENANT COMERCIAL de Conversia (F6-2). Crea/actualiza la organización desde la que opera
 * el bot que VENDE Conversia (comercial → implementación → soporte), con brand=conversia.
 * SEGURO e idempotente: upsert por slug; solo toca ESA organización (no otros tenants ni
 * TuBot). NO conecta WhatsApp (Meta queda para el final). Prompts base generalizados (sin
 * ORG_ID hardcodeado), inspirados en la estructura del tenant TuBot.
 *
 *   railway run --service Postgres -- bash -c 'cd packages/database && \
 *     DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/seed-conversia-comercial.mjs'
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Roles y estados de lead por defecto (inline, copia fiel de @conversia/types: el script
// corre con `node` directo en prod y no resuelve el paquete de workspace). Si cambian en
// @conversia/types, actualizar aquí también.
const DEFAULT_ROLES = [
  { code: "owner", name: "Propietario", permissions: ["*"] },
  { code: "admin", name: "Administrador", permissions: ["*"] },
  { code: "supervisor", name: "Supervisor", permissions: ["inbox:*", "contacts:*", "leads:*", "reports:read", "agents:read", "workflows:read"] },
  { code: "operator", name: "Operador", permissions: ["inbox:read", "inbox:write", "contacts:read", "contacts:write", "leads:read", "leads:write"] },
  { code: "viewer", name: "Solo lectura", permissions: ["inbox:read", "contacts:read", "leads:read", "reports:read"] },
];
const DEFAULT_LEAD_STATUSES = [
  { code: "new_lead", name: "Nuevo lead", emoji: "🆕", category: "OPEN", order: 0 },
  { code: "hot_lead", name: "Lead caliente", emoji: "🔥", category: "OPEN", order: 1 },
  { code: "schedule", name: "Reserva", emoji: "📅", category: "OPEN", order: 2 },
  { code: "customer", name: "Cliente", emoji: "🤩", category: "WON", order: 3 },
  { code: "cold_lead", name: "Lead frío", emoji: "🧊", category: "LOST", order: 4 },
  { code: "no_contactar", name: "No contactar", emoji: "🚫", category: "FROZEN", order: 5 },
];

const SLUG = process.env.CONVERSIA_COMMERCIAL_SLUG ?? "conversia";
const NAME = process.env.CONVERSIA_COMMERCIAL_NAME ?? "Conversia";

const LINK = "https://app.conversia.cl/registro?vertical=";

const AGENTS = [
  {
    slug: "comercial",
    name: "Asesor Comercial Conversia",
    kind: "sales",
    tools: ["getPlanes", "updateContactFields", "updateLeadStatus", "addTag", "searchKnowledgeBase", "transferToAgent", "transferToHuman"],
    config: {},
    systemPrompt:
      "Eres el asesor comercial de Conversia (conversia.cl): una plataforma de atención por WhatsApp con inteligencia artificial para negocios (bandeja, agenda, clientes y cobros, configurada por rubro). Atiendes prospectos por WhatsApp de forma cálida, clara y breve (2-3 frases, una pregunta a la vez, en un solo mensaje).\n\n" +
      "Objetivo: entender el negocio del prospecto (rubro, tamaño, qué quiere resolver) y mostrarle en concreto cómo Conversia lo ayuda, para luego guiarlo a crear su cuenta.\n\n" +
      "Reglas:\n" +
      "- Ofrece SOLO los planes de Conversia: usa la herramienta getPlanes. Nunca inventes precios, descuentos ni funciones que no existan (regla de oro: no prometas lo que el plan no incluye).\n" +
      "- Registra lo que aprendas del prospecto con updateContactFields, su rubro con addTag y su avance con updateLeadStatus.\n" +
      "- Si no sabes algo, lo reconoces y ofreces que una persona del equipo continúe (transferToHuman).\n\n" +
      "Pitch (por rubro): vendes una 'recepcionista con IA + cobros' que trabaja 24/7, NO un software de gestión. El ángulo es el costo de lo que hoy se pierde, con el dolor propio del rubro:\n" +
      "- dental/centro médico/kinesiología/psicología: el no-show y las horas que no se llenan (recordatorios + cobro anticipado).\n" +
      "- estética/medspa: leads de Meta que no se responden a tiempo y planes de varias sesiones que se estancan.\n" +
      "- barbería/peluquería: re-reserva del cliente frecuente y señas anti no-show (no 'otra agenda más').\n" +
      "- veterinaria: vacunas/controles que se olvidan (recordatorio por mascota).\n" +
      "- taller/servicios a domicilio: llamadas/mensajes sin responder = trabajos que se van a la competencia.\n" +
      "Una sola cita o lead recuperado por semana ya paga el plan. Nunca inventes precios: usa getPlanes.\n\n" +
      "Cierre (alta de autoservicio): cuando el prospecto quiera avanzar, envíale su enlace de alta con el rubro correcto: " + LINK + "RUBRO (RUBRO = dental, barberia, peluqueria, estetica, centro_medico o generico; los demás rubros se activan con el equipo). Explícale que crea su cuenta en un minuto y que de inmediato el asesor de implementación lo acompaña. Tras enviar el enlace, transfiere al asesor de implementación con transferToAgent.",
  },
  {
    slug: "implementacion",
    name: "Asesor de Implementación Conversia",
    kind: "custom",
    tools: ["updateContactFields", "addInternalNote", "searchKnowledgeBase", "triggerWorkflow", "transferToHuman"],
    config: { model: "claude-opus-4-8" },
    systemPrompt:
      "Eres el asesor de implementación de Conversia. Acompañas por WhatsApp al cliente que acaba de crear su cuenta a dejar su plataforma operativa: claro, paso a paso, una cosa a la vez (un solo mensaje por turno).\n\n" +
      "Ruta de montaje:\n" +
      "1) Confirma el rubro y el nombre del negocio.\n" +
      "2) Carga/confirma servicios y horarios de atención.\n" +
      "3) Revisa el agente de atención (tono y qué debe responder).\n" +
      "4) Deja todo publicado y listo para recibir clientes.\n\n" +
      "Mientras tanto, indícale qué configurar en su panel (app.conversia.cl) y confírmale cada paso cumplido. Cuando tengas disponibles las herramientas de montaje, úsalas.\n\n" +
      "Reglas: no inventes funciones ni des por hecho lo que no confirmaste; sé concreto y resolutivo, sin promesas vagas. Deja registro del avance del montaje con addInternalNote (para que soporte tenga el contexto). Si algo te excede o el cliente lo pide, deriva a una persona con transferToHuman.",
  },
  {
    slug: "soporte",
    name: "Soporte Conversia",
    kind: "support",
    tools: ["searchKnowledgeBase", "addInternalNote", "transferToAgent", "transferToHuman"],
    config: {},
    systemPrompt:
      "Eres soporte de Conversia. Ayudas por WhatsApp a clientes que ya operan con la plataforma: cálido, breve y resolutivo (un solo mensaje por turno).\n\n" +
      "Respondes dudas de uso con la base de conocimiento (searchKnowledgeBase) y el contexto del cliente. Si el tema es de ventas o del montaje inicial, deriva al agente correspondiente con transferToAgent. Si no puedes resolver o el cliente lo pide, deriva a una persona del equipo con transferToHuman y deja una nota con el contexto (addInternalNote).\n\n" +
      "Reglas: nunca inventes soluciones ni estados; si no sabes, lo reconoces con honestidad.",
  },
];

async function upsertAgent(orgId, a) {
  const agent = await prisma.agent.upsert({
    where: { organizationId_slug: { organizationId: orgId, slug: a.slug } },
    update: { name: a.name, kind: a.kind },
    create: { organizationId: orgId, slug: a.slug, name: a.name, kind: a.kind, active: true },
  });
  let version = await prisma.agentVersion.findFirst({ where: { agentId: agent.id }, orderBy: { version: "desc" } });
  if (!version) {
    version = await prisma.agentVersion.create({
      data: {
        organizationId: orgId,
        agentId: agent.id,
        version: 1,
        status: "PUBLISHED",
        systemPrompt: a.systemPrompt,
        config: a.config ?? {},
        tools: a.tools ?? [],
        publishedAt: new Date(),
        changelog: "Tenant comercial Conversia (F6-2)",
      },
    });
  } else {
    // Actualiza el prompt/tools de la versión más reciente (idempotente).
    version = await prisma.agentVersion.update({
      where: { id: version.id },
      data: { systemPrompt: a.systemPrompt, config: a.config ?? {}, tools: a.tools ?? [], status: "PUBLISHED", publishedAt: new Date() },
    });
  }
  await prisma.agent.update({ where: { id: agent.id }, data: { currentVersionId: version.id, active: true } });
}

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: SLUG },
    update: { brand: "conversia" },
    create: { name: NAME, slug: SLUG, brand: "conversia", country: "CL", currency: "CLP", status: "ACTIVE", settings: { general: { industry: "generico" } } },
  });
  console.log(`✔ Org comercial ${NAME} (${SLUG}) id=${org.id} brand=conversia`);

  for (const r of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { organizationId_code: { organizationId: org.id, code: r.code } },
      update: { name: r.name, permissions: [...r.permissions] },
      create: { organizationId: org.id, code: r.code, name: r.name, permissions: [...r.permissions], system: true },
    });
  }
  console.log(`✔ ${DEFAULT_ROLES.length} roles`);

  for (const s of DEFAULT_LEAD_STATUSES) {
    await prisma.leadStatus.upsert({
      where: { organizationId_code: { organizationId: org.id, code: s.code } },
      update: { name: s.name, emoji: s.emoji, category: s.category, order: s.order },
      create: { organizationId: org.id, code: s.code, name: s.name, emoji: s.emoji, category: s.category, order: s.order, system: true },
    });
  }
  console.log(`✔ ${DEFAULT_LEAD_STATUSES.length} estados de lead`);

  for (const a of AGENTS) await upsertAgent(org.id, a);
  console.log(`✔ ${AGENTS.length} agentes: ${AGENTS.map((a) => a.slug).join(", ")}`);
  console.log("Tenant comercial Conversia listo (sin canal de WhatsApp — Meta se conecta al final).");
}

main()
  .catch((e) => {
    console.error("✖", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
