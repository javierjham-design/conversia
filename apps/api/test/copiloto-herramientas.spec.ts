import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * COP 1 — las HERRAMIENTAS con las que el copiloto actúa, contra una base de datos falsa.
 *
 * Lo que se prueba acá es lo que puede costar dinero o dejar al cliente peor de lo que
 * estaba: que un asistente nuevo NUNCA nazca con el modelo de la plantilla (en Conversia el
 * modelo lo fija la plataforma y multiplica el consumo), que publicar esté condicionado a
 * que la prueba pase, que un profesional sin horario no se guarde (no genera ninguna hora
 * ofrecible) y que cada escritura deje asiento.
 */

const qa = { ok: true, passed: true, published: true, corrected: false, results: [] as { name: string; pass: boolean }[], error: undefined as string | undefined };

vi.mock("../src/agents/agent-qa", () => ({ runQaBattery: async () => qa }));
vi.mock("../src/agents/model-policy", () => ({ defaultAgentModel: async () => "gpt-4o-mini" }));
vi.mock("../src/agents/agent-test", () => ({
  runAgentTest: async () => ({ ok: true, reply: "Hola, ¿en qué te ayudo?" }),
  DEFAULT_PROMPT: "Eres un asistente.",
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
}));

import { runSetupTool, isSetupWriteTool, setupToolSpecs } from "../src/assistant/setup-tools";

type Row = Record<string, any>;

/** Base de datos falsa: guarda lo escrito para poder afirmarlo. */
function fakePrisma(initial: { settings?: Row; name?: string } = {}) {
  const db = {
    org: { name: initial.name ?? "Mi negocio", settings: initial.settings ?? {} },
    auditLogs: [] as Row[],
    professionals: [] as Row[],
    agents: [] as Row[],
    agentVersions: [] as Row[],
    canales: { activos: 0, sinAgente: 0 },
    ultimoError: null as string | null,
    verticalDefinition: null as Row | null,
  };
  const tx = {
    professional: {
      findFirst: async () => db.professionals.find((p) => p.active) ?? null,
      create: async ({ data, select }: Row) => {
        const row = { id: `pro-${db.professionals.length + 1}`, ...data };
        db.professionals.push(row);
        return select ? { id: row.id } : row;
      },
    },
    agent: {
      findUnique: async () => null,
      create: async ({ data }: Row) => {
        const row = { id: `ag-${db.agents.length + 1}`, ...data };
        db.agents.push(row);
        return row;
      },
    },
    agentVersion: {
      findFirst: async () => db.agentVersions.at(-1) ?? null,
      create: async ({ data }: Row) => {
        db.agentVersions.push(data);
        return data;
      },
      update: async ({ data }: Row) => {
        Object.assign(db.agentVersions[db.agentVersions.length - 1], data);
        return data;
      },
    },
  };
  const prisma = {
    admin: {
      organization: {
        findUnique: async () => ({ name: db.org.name, settings: db.org.settings }),
        update: async ({ data }: Row) => {
          if (data.name) db.org.name = data.name;
          if (data.settings) db.org.settings = data.settings;
          return db.org;
        },
      },
      auditLog: { create: async ({ data }: Row) => void db.auditLogs.push(data) },
      channelConnection: {
        count: async ({ where }: Row) => (where?.defaultAgentId === null ? db.canales.sinAgente : db.canales.activos),
      },
      integrationEvent: { findFirst: async () => (db.ultimoError ? { message: db.ultimoError } : null) },
      verticalTemplate: { findFirst: async () => (db.verticalDefinition ? { definition: db.verticalDefinition } : null) },
      agent: {
        findFirst: async () => db.agents.at(-1) ?? null,
        findMany: async () => db.agents.map((a) => ({ ...a, versions: [] })),
      },
      agentVersion: { findFirst: async () => db.agentVersions.at(-1) ?? null },
    },
    withTenant: async (_orgId: string, fn: (t: typeof tx) => unknown) => fn(tx),
  };
  return { prisma: prisma as never, db };
}

const ctx = { organizationId: "org-1", userId: "user-1" };

beforeEach(() => {
  qa.ok = true;
  qa.passed = true;
  qa.results = [];
  qa.error = undefined;
});

describe("el registro de herramientas", () => {
  it("devuelve null para un nombre que no es de este módulo (no se traga ajenos)", async () => {
    const { prisma } = fakePrisma();
    expect(await runSetupTool(prisma, ctx, "crearServicio", {})).toBeNull();
  });

  it("marca como de ESCRITURA solo las que escriben", () => {
    expect(isSetupWriteTool("completarDatosNegocio")).toBe(true);
    expect(isSetupWriteTool("publicarAsistente")).toBe(true);
    expect(isSetupWriteTool("diagnosticarWhatsapp")).toBe(false);
    expect(isSetupWriteTool("acompañarPaso")).toBe(false);
  });

  it("ninguna herramienta promete cambiar el modelo de IA", () => {
    const todas = [...setupToolSpecs().read, ...setupToolSpecs().write];
    const texto = JSON.stringify(todas).toLowerCase();
    expect(texto).not.toMatch(/cambiar el modelo|elegir el modelo/);
    expect(todas.some((t) => /modelo/i.test(t.name))).toBe(false);
  });
});

describe("completarDatosNegocio", () => {
  it("guarda nombre, rubro y dirección donde los lee el checklist, y refresca el avance", async () => {
    const { prisma, db } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "completarDatosNegocio", {
      nombre: "Barbería Central",
      rubro: "barberia",
      direccion: "Av. Siempre Viva 742",
    });
    expect(r?.didWrite).toBe(true);
    expect(r?.actions).toEqual([{ type: "checklist_refresh" }]);
    expect(db.org.name).toBe("Barbería Central");
    expect(db.org.settings.general.industry).toBe("barberia");
    expect(db.org.settings.business.direccion).toBe("Av. Siempre Viva 742");
  });

  it("rechaza un rubro inventado y ofrece el catálogo", async () => {
    const { prisma, db } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "completarDatosNegocio", { rubro: "lo-que-sea" });
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/barberia/);
    expect(db.org.settings.general).toBeUndefined();
  });

  it("guardar un campo NO borra los otros", async () => {
    const { prisma, db } = fakePrisma({ settings: { general: { industry: "dental" }, business: { website: "https://x.cl" } } });
    await runSetupTool(prisma, ctx, "completarDatosNegocio", { direccion: "Calle 1" });
    expect(db.org.settings.general.industry).toBe("dental");
    expect(db.org.settings.business.website).toBe("https://x.cl");
    expect(db.org.settings.business.direccion).toBe("Calle 1");
  });

  it("deja asiento de auditoría con el usuario que lo pidió", async () => {
    const { prisma, db } = fakePrisma();
    await runSetupTool(prisma, ctx, "completarDatosNegocio", { nombre: "Nuevo Nombre" });
    expect(db.auditLogs.at(-1)?.actorId).toBe("user-1");
  });
});

describe("configurarHorarioAtencion", () => {
  it("guarda el horario que el dueño dicta y lo confirma en palabras", async () => {
    const { prisma, db } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "configurarHorarioAtencion", {
      tramos: [{ dia: "lunes", desde: "9", hasta: "18" }],
    });
    expect(r?.didWrite).toBe(true);
    expect(r?.content).toMatch(/lun 09:00-18:00/);
    expect(db.org.settings.businessHours.hours).toEqual({ mon: [{ from: "09:00", to: "18:00" }] });
  });

  it("si no entiende NADA, no guarda y pide que se lo repitan", async () => {
    const { prisma, db } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "configurarHorarioAtencion", {
      tramos: [{ dia: "lunez", desde: "tarde", hasta: "noche" }],
    });
    expect(r?.isError).toBe(true);
    expect(db.org.settings.businessHours).toBeUndefined();
  });

  it("guarda lo que entendió y AVISA lo que descartó (no se lo come en silencio)", async () => {
    const { prisma } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "configurarHorarioAtencion", {
      tramos: [{ dia: "lun", desde: "9", hasta: "18" }, { dia: "mar", desde: "18", hasta: "9" }],
    });
    expect(r?.didWrite).toBe(true);
    expect(r?.content).toMatch(/No pude usar/);
  });

  it("conserva los feriados ya cargados", async () => {
    const { prisma, db } = fakePrisma({ settings: { businessHours: { holidays: ["2026-12-25"] } } });
    await runSetupTool(prisma, ctx, "configurarHorarioAtencion", { tramos: [{ dia: "lun", desde: "9", hasta: "18" }] });
    expect(db.org.settings.businessHours.holidays).toEqual(["2026-12-25"]);
  });
});

describe("crearProfesional", () => {
  it("lo guarda con su horario semanal", async () => {
    const { prisma, db } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "crearProfesional", {
      nombre: "Ana",
      tramos: [{ dia: "lun", desde: "9", hasta: "18" }],
    });
    expect(r?.didWrite).toBe(true);
    expect(db.professionals[0].meta.workingHours).toEqual([{ day: "mon", start: "09:00", end: "18:00" }]);
  });

  it("SIN horario no lo guarda: no generaría ninguna hora ofrecible", async () => {
    const { prisma, db } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "crearProfesional", { nombre: "Ana", tramos: [] });
    expect(r?.isError).toBe(true);
    expect(db.professionals).toHaveLength(0);
  });

  it("no duplica a alguien que ya está cargado", async () => {
    const { prisma, db } = fakePrisma();
    db.professionals.push({ id: "pro-0", name: "Ana", active: true });
    const r = await runSetupTool(prisma, ctx, "crearProfesional", { nombre: "Ana", tramos: [{ dia: "lun", desde: "9", hasta: "18" }] });
    expect(r?.isError).toBe(true);
    expect(db.professionals).toHaveLength(1);
  });
});

describe("configurarAgenda", () => {
  it("guarda el bloque entre horas conservando lo demás", async () => {
    const { prisma, db } = fakePrisma({ settings: { agenda: { slotStepMin: 30, bufferMin: 10, minAdvanceMin: 60 } } });
    const r = await runSetupTool(prisma, ctx, "configurarAgenda", { bloqueMin: 15 });
    expect(r?.didWrite).toBe(true);
    expect(db.org.settings.agenda).toEqual({ slotStepMin: 15, bufferMin: 10, minAdvanceMin: 60 });
  });

  it("rechaza un bloque imposible en vez de guardarlo", async () => {
    const { prisma, db } = fakePrisma();
    expect((await runSetupTool(prisma, ctx, "configurarAgenda", { bloqueMin: 1 }))?.isError).toBe(true);
    expect((await runSetupTool(prisma, ctx, "configurarAgenda", { bloqueMin: 999 }))?.isError).toBe(true);
    expect(db.org.settings.agenda).toBeUndefined();
  });
});

describe("crearAsistente", () => {
  const vertical = {
    agents: [
      { slug: "recepcion", name: "Recepción", description: "Atiende y agenda", kind: "support", systemPrompt: "Prompt del rubro.", config: { model: "claude-opus-4-8", maxTokens: 4000 }, tools: ["getServices"] },
    ],
  };

  it("lista las plantillas del RUBRO del negocio", async () => {
    const { prisma, db } = fakePrisma({ settings: { general: { industry: "barberia" } } });
    db.verticalDefinition = vertical;
    const r = await runSetupTool(prisma, ctx, "listarPlantillasAsistente", {});
    expect(JSON.parse(r!.content).plantillas[0]).toEqual({ clave: "recepcion", nombre: "Recepción", para: "Atiende y agenda" });
  });

  it("sin rubro cargado, pide el rubro antes de crear nada", async () => {
    const { prisma } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "listarPlantillasAsistente", {});
    const out = JSON.parse(r!.content);
    expect(out.rubro).toBeNull();
    expect(out.nota).toMatch(/rubro/i);
  });

  it("IGNORA el modelo de la plantilla y usa el que fija la plataforma", async () => {
    const { prisma, db } = fakePrisma({ settings: { general: { industry: "barberia" } } });
    db.verticalDefinition = vertical;
    const r = await runSetupTool(prisma, ctx, "crearAsistente", { nombre: "Recepción", plantilla: "recepcion" });
    expect(r?.didWrite).toBe(true);
    expect(db.agentVersions[0].config).toMatchObject({ model: "gpt-4o-mini" });
    expect(db.agentVersions[0].config.model).not.toBe("claude-opus-4-8");
  });

  it("nace en BORRADOR (un asistente publicado sin probar atiende mal)", async () => {
    const { prisma, db } = fakePrisma({ settings: { general: { industry: "barberia" } } });
    db.verticalDefinition = vertical;
    await runSetupTool(prisma, ctx, "crearAsistente", { nombre: "Recepción", plantilla: "recepcion" });
    expect(db.agentVersions[0].status).toBe("DRAFT");
  });

  it("anexa lo que contó el dueño al prompt de la plantilla", async () => {
    const { prisma, db } = fakePrisma({ settings: { general: { industry: "barberia" } } });
    db.verticalDefinition = vertical;
    await runSetupTool(prisma, ctx, "crearAsistente", { nombre: "Recepción", plantilla: "recepcion", comoAtiende: "Nunca damos precios por teléfono." });
    expect(db.agentVersions[0].systemPrompt).toContain("Prompt del rubro.");
    expect(db.agentVersions[0].systemPrompt).toContain("Nunca damos precios por teléfono.");
  });

  it("rechaza una plantilla que no está en el rubro", async () => {
    const { prisma, db } = fakePrisma({ settings: { general: { industry: "barberia" } } });
    db.verticalDefinition = vertical;
    const r = await runSetupTool(prisma, ctx, "crearAsistente", { nombre: "X", plantilla: "inventada" });
    expect(r?.isError).toBe(true);
    expect(db.agents).toHaveLength(0);
  });
});

describe("publicarAsistente", () => {
  it("publica y celebra cuando la prueba pasa", async () => {
    const { prisma, db } = fakePrisma();
    db.agents.push({ id: "ag-1", name: "Recepción" });
    const r = await runSetupTool(prisma, ctx, "publicarAsistente", {});
    expect(r?.didWrite).toBe(true);
    expect(r?.actions).toEqual([{ type: "celebrate", step: "asistente" }, { type: "checklist_refresh" }]);
  });

  it("NO publica si la prueba falla, y dice qué revisar", async () => {
    const { prisma, db } = fakePrisma();
    db.agents.push({ id: "ag-1", name: "Recepción" });
    qa.passed = false;
    qa.results = [{ name: "no inventa precios", pass: false }];
    const r = await runSetupTool(prisma, ctx, "publicarAsistente", {});
    expect(r?.isError).toBe(true);
    expect(r?.didWrite).toBeUndefined();
    expect(r?.content).toMatch(/no inventa precios/);
  });

  it("sin asistente, ofrece crearlo en vez de reventar", async () => {
    const { prisma } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "publicarAsistente", {});
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/creamos/i);
  });
});

describe("diagnosticarWhatsapp", () => {
  it("avisa primero del canal conectado SIN asistente", async () => {
    const { prisma, db } = fakePrisma();
    db.canales = { activos: 1, sinAgente: 1 };
    const r = await runSetupTool(prisma, ctx, "diagnosticarWhatsapp", {});
    expect(JSON.parse(r!.content).camino).toBe("asignar_agente");
    // Ese caso NO ofrece botón de conexión: no hay nada que conectar.
    expect(r?.actions ?? []).toEqual([]);
  });

  it("sin canal, entrega el BOTÓN de conexión (el popup de Meta exige un clic)", async () => {
    const { prisma } = fakePrisma();
    const r = await runSetupTool(prisma, ctx, "diagnosticarWhatsapp", { yaAtiendePorWhatsapp: true });
    expect(JSON.parse(r!.content).camino).toBe("coexistencia");
    expect(r?.actions).toEqual([{ type: "button", label: "Conectar mi WhatsApp", kind: "whatsapp", payload: "coexistencia" }]);
  });
});

describe("acompañarPaso", () => {
  it("navega, resalta y agrega el botón cuando el paso lo exige", async () => {
    const { prisma } = fakePrisma();
    const r = await runSetupTool(prisma, { ...ctx, route: "/inicio" }, "acompañarPaso", { paso: "pago" });
    expect(r?.actions?.map((a) => a.type)).toEqual(["navigate", "highlight", "button"]);
  });

  it("un paso inventado no hace nada", async () => {
    const { prisma } = fakePrisma();
    expect((await runSetupTool(prisma, ctx, "acompañarPaso", { paso: "volar" }))?.isError).toBe(true);
  });
});

describe("activarMiniSitio", () => {
  it("lo publica conservando los textos ya cargados", async () => {
    const { prisma, db } = fakePrisma({ settings: { miniSite: { tagline: "Cortes a tu medida" } } });
    const r = await runSetupTool(prisma, ctx, "activarMiniSitio", {});
    expect(r?.didWrite).toBe(true);
    expect(db.org.settings.miniSite).toEqual({ tagline: "Cortes a tu medida", enabled: true });
  });
});
