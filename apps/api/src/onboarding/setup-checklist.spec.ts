import { describe, it, expect } from "vitest";
import {
  EMPTY_SETUP_FACTS,
  buildSetupSteps,
  getSetupChecklist,
  readSetupFacts,
  summarizeSetupChecklist,
  type SetupFacts,
} from "./setup-checklist";

/**
 * ETAPA 0 — el checklist único de montaje. Lo que estos tests cuidan es justo lo que la
 * auditoría encontró roto: que el porcentaje mienta (agente en borrador contado como listo,
 * canal sin agente contado como conectado) y que los pasos opcionales impidan el 100%.
 */

const checklistOf = (facts: SetupFacts) => summarizeSetupChecklist(buildSetupSteps(facts));

/** Org con TODO el montaje hecho (y ningún opcional) — para probar el 100% real. */
const FULL: SetupFacts = {
  ...EMPTY_SETUP_FACTS,
  hasBusinessName: true,
  hasIndustry: true,
  hasAddress: true,
  hasBusinessHours: true,
  servicesPriced: 3,
  agendaModule: true,
  professionalsWithHours: 1,
  publishedAgents: 1,
  whatsappConnected: true,
  channelsWithAgent: 1,
  botReplied: true,
  planActive: true,
  hasPaymentMethod: false,
};

describe("checklist de montaje — avance", () => {
  it("org recién creada: 0% y ningún paso bloqueante hecho", () => {
    const c = checklistOf(EMPTY_SETUP_FACTS);
    expect(c.percent).toBe(0);
    expect(c.blockingCompleted).toBe(0);
    expect(c.steps.filter((s) => s.blocking).every((s) => !s.done)).toBe(true);
    expect(c.done).toBe(false);
    // El copiloto siempre tiene algo concreto que proponer.
    expect(c.nextStep?.key).toBe("negocio");
  });

  it("org con el montaje completo: 100% aunque NINGÚN opcional esté hecho", () => {
    const c = checklistOf(FULL);
    expect(c.percent).toBe(100);
    expect(c.done).toBe(true);
    expect(c.nextStep).toBeNull();
    // Los opcionales siguen pendientes y no descuentan: eso es lo que pide la Etapa 0.
    const opcionales = c.steps.filter((s) => !s.blocking);
    expect(opcionales.length).toBeGreaterThan(0);
    expect(opcionales.every((s) => !s.done)).toBe(true);
  });

  it("los pasos opcionales nunca entran en el porcentaje", () => {
    const soloOpcionales = checklistOf({
      ...EMPTY_SETUP_FACTS,
      miniSiteEnabled: true,
      teamMembers: 4,
      pwaInstalled: true,
      pushDevices: 2,
      emailVerified: true,
    });
    expect(soloOpcionales.percent).toBe(0); // 5 opcionales hechos no mueven la aguja
    expect(soloOpcionales.completed).toBe(5); // pero sí se ven como hechos en la lista
  });

  it("el paso de agenda solo existe si el rubro agenda citas", () => {
    const conAgenda = checklistOf({ ...EMPTY_SETUP_FACTS, agendaModule: true });
    const sinAgenda = checklistOf({ ...EMPTY_SETUP_FACTS, agendaModule: false });
    expect(conAgenda.steps.some((s) => s.key === "agenda")).toBe(true);
    expect(sinAgenda.steps.some((s) => s.key === "agenda")).toBe(false);
    // Un comercio no puede quedar atascado bajo el 100% por un paso que no le aplica.
    expect(sinAgenda.blockingTotal).toBe(conAgenda.blockingTotal - 1);
    const comercioListo = checklistOf({ ...FULL, agendaModule: false, professionalsWithHours: 0 });
    expect(comercioListo.percent).toBe(100);
  });

  it("todo paso declara key, label en español, blocking y href", () => {
    for (const s of buildSetupSteps(EMPTY_SETUP_FACTS)) {
      expect(s.key).toMatch(/^[a-z_]+$/);
      expect(s.label.length).toBeGreaterThan(5);
      expect(typeof s.blocking).toBe("boolean");
      expect(s.href.startsWith("/")).toBe(true);
      // Contrato viejo de /onboarding (lo consume canales/page.tsx): sigue completo.
      expect(s.cta.href).toBe(s.href);
      expect(s.title).toBe(s.label);
      expect(s.description.length).toBeGreaterThan(10);
    }
  });
});

describe("checklist de montaje — condiciones que la auditoría encontró mal", () => {
  it("asistente: un agente en BORRADOR no cuenta como publicado (hallazgo 1)", () => {
    const borrador = checklistOf({ ...FULL, publishedAgents: 0 });
    expect(borrador.steps.find((s) => s.key === "asistente")?.done).toBe(false);
    expect(borrador.done).toBe(false);
    const publicado = checklistOf({ ...FULL, publishedAgents: 1 });
    expect(publicado.steps.find((s) => s.key === "asistente")?.done).toBe(true);
  });

  it("WhatsApp: conectado pero SIN agente asignado al canal no está listo (hallazgo 2)", () => {
    const mudo = checklistOf({ ...FULL, whatsappConnected: true, channelsWithAgent: 0 });
    expect(mudo.steps.find((s) => s.key === "whatsapp")?.done).toBe(false);
    expect(mudo.percent).toBeLessThan(100);
    const atendido = checklistOf({ ...FULL, whatsappConnected: true, channelsWithAgent: 1 });
    expect(atendido.steps.find((s) => s.key === "whatsapp")?.done).toBe(true);
  });

  it("negocio: falta cualquiera de los 4 datos → el paso no está hecho", () => {
    const casos: [string, SetupFacts][] = [
      ["nombre", { ...FULL, hasBusinessName: false }],
      ["rubro", { ...FULL, hasIndustry: false }],
      ["direccion", { ...FULL, hasAddress: false }],
      ["horario", { ...FULL, hasBusinessHours: false }],
    ];
    const resultados = casos.map(([falta, facts]) => `${falta}:${checklistOf(facts).steps.find((s) => s.key === "negocio")?.done}`);
    expect(resultados).toEqual(["nombre:false", "rubro:false", "direccion:false", "horario:false"]);
  });

  it("servicios: el nombre solo no basta — necesita precio y duración", () => {
    expect(checklistOf({ ...FULL, servicesPriced: 0 }).steps.find((s) => s.key === "servicios")?.done).toBe(false);
  });

  it("prueba real: hasta que el bot no responda un mensaje, no está hecho", () => {
    expect(checklistOf({ ...FULL, botReplied: false }).steps.find((s) => s.key === "prueba")?.done).toBe(false);
  });

  it("pago: vale el plan activo O el método de pago cargado", () => {
    expect(checklistOf({ ...FULL, planActive: false, hasPaymentMethod: false }).steps.find((s) => s.key === "pago")?.done).toBe(false);
    expect(checklistOf({ ...FULL, planActive: false, hasPaymentMethod: true }).steps.find((s) => s.key === "pago")?.done).toBe(true);
    expect(checklistOf({ ...FULL, planActive: true, hasPaymentMethod: false }).steps.find((s) => s.key === "pago")?.done).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------- *
 * Lectura de BD: doble de Prisma que responde a los MISMOS filtros que usa el servicio,
 * para comprobar que pregunta lo correcto (PUBLISHED, defaultAgentId, AGENT/OUTBOUND…).
 * ------------------------------------------------------------------------------------- */

interface Seed {
  org?: { name?: string | null; settings?: unknown } | null;
  services?: { active: boolean; priced: boolean }[];
  professionals?: { meta: unknown }[];
  agentVersions?: { status: string }[];
  channels?: { status: string; defaultAgentId: string | null }[];
  waNumbers?: { status: string }[];
  messages?: { direction: string; authorType: string }[];
  subscriptions?: { status: string }[];
  paymentMethods?: number;
  paidInvoices?: number;
  members?: number;
  verifiedMembers?: number;
  pwaInstalled?: boolean;
  pushDevices?: number;
}

function fakePrisma(seed: Seed) {
  const services = seed.services ?? [];
  const professionals = seed.professionals ?? [];
  const agentVersions = seed.agentVersions ?? [];
  const channels = seed.channels ?? [];
  const waNumbers = seed.waNumbers ?? [];
  const messages = seed.messages ?? [];
  const subscriptions = seed.subscriptions ?? [];
  const admin = {
    organization: { findUnique: async () => seed.org ?? null },
    service: { count: async () => services.filter((x) => x.active && x.priced).length },
    professional: { findMany: async () => professionals },
    // El servicio DEBE pedir status PUBLISHED: si pidiera otra cosa, este doble lo delata.
    agentVersion: { count: async ({ where }: any) => agentVersions.filter((v) => v.status === where.status).length },
    channelConnection: {
      count: async ({ where }: any) =>
        channels.filter((c) => c.status === where.status && (where.defaultAgentId ? c.defaultAgentId !== null : true)).length,
    },
    whatsappPhoneNumber: { count: async ({ where }: any) => waNumbers.filter((n) => n.status === where.status).length },
    message: {
      findFirst: async ({ where }: any) =>
        messages.find((m) => m.direction === where.direction && m.authorType === where.authorType) ?? null,
    },
    subscription: { findFirst: async ({ where }: any) => subscriptions.find((x) => x.status === where.status) ?? null },
    paymentMethod: { count: async () => seed.paymentMethods ?? 0 },
    invoice: { count: async () => seed.paidInvoices ?? 0 },
    organizationUser: { count: async ({ where }: any) => (where.user ? (seed.verifiedMembers ?? 0) : (seed.members ?? 1)) },
    auditLog: { findFirst: async () => (seed.pwaInstalled ? { id: "a1" } : null) },
    pushDevice: { count: async () => seed.pushDevices ?? 0 },
  };
  return { admin } as any;
}

describe("readSetupFacts — lee el estado REAL del tenant", () => {
  it("agente que existe pero está en BORRADOR: el paso del asistente NO se marca hecho", async () => {
    const prisma = fakePrisma({ org: { name: "Barbería Centro", settings: {} }, agentVersions: [{ status: "DRAFT" }] });
    const facts = await readSetupFacts(prisma, "org1");
    expect(facts.publishedAgents).toBe(0);
    const c = await getSetupChecklist(prisma, "org1");
    expect(c.steps.find((st) => st.key === "asistente")?.done).toBe(false);
  });

  it("agente publicado: el paso del asistente queda hecho", async () => {
    const prisma = fakePrisma({ org: { name: "Barbería Centro", settings: {} }, agentVersions: [{ status: "DRAFT" }, { status: "PUBLISHED" }] });
    expect((await readSetupFacts(prisma, "org1")).publishedAgents).toBe(1);
  });

  it("canal conectado SIN agente asignado: el paso de WhatsApp NO se marca hecho", async () => {
    const prisma = fakePrisma({
      org: { name: "Barbería Centro", settings: {} },
      channels: [{ status: "active", defaultAgentId: null }],
    });
    const facts = await readSetupFacts(prisma, "org1");
    expect(facts.whatsappConnected).toBe(true);
    expect(facts.channelsWithAgent).toBe(0);
    const c = await getSetupChecklist(prisma, "org1");
    expect(c.steps.find((st) => st.key === "whatsapp")?.done).toBe(false);
  });

  it("canal conectado CON agente asignado: el paso de WhatsApp queda hecho", async () => {
    const prisma = fakePrisma({
      org: { name: "Barbería Centro", settings: {} },
      channels: [{ status: "active", defaultAgentId: "ag1" }],
    });
    const c = await getSetupChecklist(prisma, "org1");
    expect(c.steps.find((st) => st.key === "whatsapp")?.done).toBe(true);
  });

  it("prueba real: solo cuenta un mensaje SALIENTE escrito por el AGENTE", async () => {
    const soloEquipo = fakePrisma({
      org: { name: "N", settings: {} },
      messages: [{ direction: "OUTBOUND", authorType: "USER" }, { direction: "INBOUND", authorType: "CONTACT" }],
    });
    expect((await readSetupFacts(soloEquipo, "org1")).botReplied).toBe(false);
    const conBot = fakePrisma({ org: { name: "N", settings: {} }, messages: [{ direction: "OUTBOUND", authorType: "AGENT" }] });
    expect((await readSetupFacts(conBot, "org1")).botReplied).toBe(true);
  });

  it("datos del negocio: nombre + rubro + dirección + horario salen de settings", async () => {
    const prisma = fakePrisma({
      org: {
        name: "Barbería Centro",
        settings: {
          general: { industry: "barberia" },
          business: { direccion: "Av. Alemania 1234, Temuco" },
          businessHours: { hours: { mon: [{ start: "09:00", end: "19:00" }] } },
        },
      },
    });
    const facts = await readSetupFacts(prisma, "org1");
    expect(facts.hasBusinessName && facts.hasIndustry && facts.hasAddress && facts.hasBusinessHours).toBe(true);
    expect(facts.agendaModule).toBe(true); // barbería agenda citas
  });

  it("rubro sin agenda (comercio): el paso de agenda no se exige", async () => {
    const prisma = fakePrisma({ org: { name: "Tienda", settings: { general: { industry: "comercio" } } } });
    expect((await readSetupFacts(prisma, "org1")).agendaModule).toBe(false);
    expect((await getSetupChecklist(prisma, "org1")).steps.some((s) => s.key === "agenda")).toBe(false);
  });

  it("horario vacío no cuenta como horario cargado", async () => {
    const prisma = fakePrisma({ org: { name: "N", settings: { businessHours: { hours: { mon: [] } } } } });
    expect((await readSetupFacts(prisma, "org1")).hasBusinessHours).toBe(false);
  });

  it("profesional sin horario semanal no habilita el paso de agenda", async () => {
    const sinHorario = fakePrisma({ org: { name: "N", settings: {} }, professionals: [{ meta: {} }] });
    expect((await readSetupFacts(sinHorario, "org1")).professionalsWithHours).toBe(0);
    const conHorario = fakePrisma({
      org: { name: "N", settings: {} },
      professionals: [{ meta: { workingHours: [{ day: 1, start: "09:00", end: "18:00" }] } }],
    });
    expect((await readSetupFacts(conHorario, "org1")).professionalsWithHours).toBe(1);
  });

  it("reusa la organización que ya leyó el caller (no vuelve a consultarla)", async () => {
    const prisma = fakePrisma({ org: null });
    prisma.admin.organization.findUnique = async () => {
      throw new Error("no debería consultarse");
    };
    const facts = await readSetupFacts(prisma, "org1", { org: { name: "Pasada por el caller", settings: {} } });
    expect(facts.hasBusinessName).toBe(true);
  });

  it("una tabla que falla degrada ese paso, no tumba el checklist", async () => {
    const prisma = fakePrisma({ org: { name: "N", settings: {} } });
    prisma.admin.pushDevice.count = async () => {
      throw new Error("relation \"push_devices\" does not exist");
    };
    const c = await getSetupChecklist(prisma, "org1");
    expect(c.steps.find((s) => s.key === "notificaciones")?.done).toBe(false);
    expect(c.steps.length).toBeGreaterThan(5);
  });
});
