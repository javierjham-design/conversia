import { describe, expect, it } from "vitest";
import { AssistantService } from "../src/assistant/assistant.service";
import { runSetupTool, setupToolSpecs, type SetupToolCtx } from "../src/assistant/setup-tools";
import { EMPTY_SETUP_FACTS, buildSetupSteps, summarizeSetupChecklist } from "../src/onboarding/setup-checklist";
import type { ReporteDeCanal } from "../src/channels/channel-status";
import type { PrismaService } from "../src/prisma.service";

/**
 * C4 — CONVI CONOCE LOS TRES CANALES.
 *
 * Antes Convi solo sabía de WhatsApp: si el dueño decía "me escriben por Instagram", lo
 * mejor que podía hacer era derivarlo. Ahora lee el estado de los tres, sabe cómo se
 * conecta cada uno y qué significa que Meta esté revisando la app.
 */

const base = (over: Partial<ReporteDeCanal>): ReporteDeCanal => ({
  channelId: "c",
  channelType: "WHATSAPP_CLOUD",
  channelName: "WhatsApp",
  displayPhone: "+56 9 1234 5678",
  verifiedName: null,
  qualityRating: "GREEN",
  mode: "coexistence",
  coexVerified: true,
  pendingNumber: false,
  wabaId: "9",
  channelStatus: "active",
  tokenHealthy: true,
  accountAlert: null,
  webhookSubscribed: true,
  defaultAgent: { id: "ag1", name: "Recepción" },
  lastInboundAt: null,
  lastOutboundAt: null,
  checks: [],
  ...over,
});

/** Prisma falso: solo se le piden los canales de la org. */
function fakePrisma(canales: Array<{ id: string; type: string }>): PrismaService {
  return {
    admin: {
      channelConnection: { findMany: async ({ where }: any) => canales.filter((c) => (where?.type?.in ?? [c.type]).includes(c.type)).map((c) => ({ id: c.id })), count: async () => canales.length },
      integrationEvent: { findFirst: async () => null },
    },
  } as unknown as PrismaService;
}

const ctxCon = (porId: Record<string, ReporteDeCanal>): SetupToolCtx => ({
  organizationId: "org1",
  userId: "u1",
  estado: { reporte: async (_o: string, id: string) => porId[id] },
});

const leer = async (canales: Array<{ id: string; type: string }>, porId: Record<string, ReporteDeCanal>) => {
  const r = await runSetupTool(fakePrisma(canales), ctxCon(porId), "estadoCanales", {});
  return { r, datos: JSON.parse(r!.content) as Record<string, any> };
};

describe("la herramienta estadoCanales", () => {
  it("está declarada entre las de LECTURA", () => {
    expect(setupToolSpecs().read.map((s) => s.name)).toContain("estadoCanales");
    expect(setupToolSpecs().write.map((s) => s.name)).not.toContain("estadoCanales");
  });

  it("cuenta los tres canales con su nombre humano y quién atiende", async () => {
    const { datos } = await leer(
      [{ id: "wa", type: "WHATSAPP_CLOUD" }, { id: "ig", type: "INSTAGRAM" }],
      {
        wa: base({ channelId: "wa" }),
        ig: base({ channelId: "ig", channelType: "INSTAGRAM", channelName: "Instagram · @barberia", displayPhone: null, reviewApproved: true }),
      },
    );
    expect(datos.canales.map((c: any) => c.canal)).toEqual(["WhatsApp", "Instagram"]);
    expect(datos.canales[1].nombre).toBe("Instagram · @barberia");
    expect(datos.canales.every((c: any) => c.atiende === "Recepción")).toBe(true);
    // Messenger no está conectado: se dice, para poder ofrecerlo.
    expect(datos.sinConectar).toEqual(["Messenger"]);
  });

  it("avisa cuando Meta todavía está revisando la app", async () => {
    const { datos } = await leer([{ id: "ig", type: "INSTAGRAM" }], {
      ig: base({ channelId: "ig", channelType: "INSTAGRAM", displayPhone: null, reviewApproved: false }),
    });
    expect(datos.canales[0].enRevisionDeMeta).toBe(true);
  });

  it("en WhatsApp no inventa una revisión de Meta que no aplica", async () => {
    const { datos } = await leer([{ id: "wa", type: "WHATSAPP_CLOUD" }], { wa: base({ channelId: "wa" }) });
    expect(datos.canales[0].enRevisionDeMeta).toBeUndefined();
  });

  it("explica cómo se conecta cada uno, con el requisito de Instagram por delante", async () => {
    const { datos } = await leer([], {});
    expect(datos.comoSeConectan.Instagram).toMatch(/página de Facebook vinculada/i);
    expect(datos.comoSeConectan.Messenger).toMatch(/administrador de la página/i);
    expect(datos.nota).toMatch(/mismo asistente/i);
    expect(datos.sinConectar).toEqual(["Instagram", "Messenger"]);
  });

  it("lo pendiente llega con qué hacer, y nada de tokens", async () => {
    const { r, datos } = await leer([{ id: "ig", type: "INSTAGRAM" }], {
      ig: base({
        channelId: "ig",
        channelType: "INSTAGRAM",
        displayPhone: null,
        defaultAgent: null,
        checks: [
          { key: "asistente", label: "Un asistente atiende este canal", ok: false, detail: "Nadie está asignado.", fix: "Asigna tu asistente." },
          { key: "webhook", label: "Meta nos avisa de tus mensajes", ok: false, unknown: true, detail: "No pudimos comprobarlo." },
        ],
      }),
    });
    expect(datos.canales[0].pendientes).toEqual([{ que: "Un asistente atiende este canal", explicacion: "Nadie está asignado.", comoSeArregla: "Asigna tu asistente." }]);
    expect(r!.content).not.toMatch(/"(access_?token|token|secret|ciphertext)"\s*:/i);
  });
});

describe("el paso «redes» del checklist es OPCIONAL", () => {
  /** Todo lo bloqueante listo; lo opcional sin hacer. */
  const facts = (over: Record<string, unknown> = {}) => {
    const steps = buildSetupSteps({
      ...EMPTY_SETUP_FACTS,
      businessComplete: true,
      servicesPriced: 1,
      professionalsWithHours: 1,
      publishedAgents: 1,
      whatsappConnected: true,
      channelsWithAgent: 1,
      socialChannels: 0,
      botReplied: true,
      planActive: true,
      agendaModule: true,
      ...over,
    } as never);
    return summarizeSetupChecklist(steps);
  };

  it("existe y NO bloquea el 100%", () => {
    const pasos = facts();
    const redes = pasos.steps.find((s) => s.key === "redes")!;
    expect(redes).toBeTruthy();
    expect(redes.blocking).toBe(false);
    // Sin redes conectadas, el avance de lo BLOQUEANTE sigue completo: a muchos negocios
    // sus clientes solo les escriben por WhatsApp, y exigirles Instagram sería inventarles
    // una tarea para llegar al 100%.
    // Lo que importa no es el número: es que conectar (o no) una red NO mueva el avance
    // del montaje. A muchos negocios sus clientes solo les escriben por WhatsApp.
    expect(facts({ socialChannels: 1 }).percent).toBe(pasos.percent);
    expect(pasos.steps.filter((s) => s.blocking).map((s) => s.key)).not.toContain("redes");
  });

  it("se marca hecho cuando hay un canal de redes conectado", () => {
    expect(facts({ socialChannels: 1 }).steps.find((s) => s.key === "redes")!.done).toBe(true);
  });

  it("lleva a Canales, que es donde se conecta", () => {
    expect(facts().steps.find((s) => s.key === "redes")!.href).toBe("/canales");
  });
});

describe("el prompt de Convi habla de los tres canales", () => {
  const svc = new AssistantService({} as never, {} as never);
  const prompt = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    true,
    "/canales",
  );

  it("sabe que se conectan desde Canales con un botón", () => {
    expect(prompt).toMatch(/INSTAGRAM Y MESSENGER/);
    expect(prompt).toMatch(/desde Canales/i);
    expect(prompt).toContain("estadoCanales");
  });

  it("dice el requisito de Instagram antes de que el cliente se meta en Meta", () => {
    expect(prompt).toMatch(/página de Facebook vinculada a su cuenta de Instagram profesional/i);
  });

  it("explica «en revisión por Meta» sin prometer fechas", () => {
    expect(prompt).toMatch(/EN REVISIÓN POR META/i);
    expect(prompt).toMatch(/no prometas fechas/i);
    expect(prompt).toMatch(/no es un error/i);
  });

  it("deja claro que es el MISMO asistente en los tres", () => {
    expect(prompt).toMatch(/mismo asistente atiende los tres/i);
  });
});
