import { describe, expect, it } from "vitest";
import { AssistantService } from "../src/assistant/assistant.service";
import { sanitizeActions } from "../src/assistant/actions";
import { runSetupTool, setupToolSpecs, type SetupToolCtx } from "../src/assistant/setup-tools";
import type { ReporteDeCanal } from "../src/channels/channel-status";
import type { PrismaService } from "../src/prisma.service";

/**
 * A3 — CONVI SABE EL ESTADO REAL DE LA CUENTA DE WHATSAPP.
 *
 * Antes solo sabía CONTAR canales: podía decirle al dueño "tienes WhatsApp conectado" con el
 * acceso de Meta vencido, el webhook sin suscribir o el número todavía sin publicar. Ahora
 * mira el mismo reporte que la pantalla de Canales, así que los dos cuentan la misma historia.
 */

const REPORTE: ReporteDeCanal = {
  channelId: "ch1",
  channelType: "WHATSAPP_CLOUD",
  channelName: "WhatsApp +56 9 1234 5678",
  displayPhone: "+56 9 1234 5678",
  verifiedName: "Barbería Centro",
  qualityRating: "GREEN",
  mode: "coexistence",
  coexVerified: true,
  pendingNumber: false,
  wabaId: "999",
  channelStatus: "active",
  tokenHealthy: true,
  accountAlert: null,
  webhookSubscribed: true,
  defaultAgent: { id: "ag1", name: "Recepción" },
  lastInboundAt: "2026-11-10T14:00:00.000Z",
  lastOutboundAt: "2026-11-10T14:00:07.000Z",
  checks: [
    { key: "numero", label: "Tu número está publicado en Meta", ok: true, detail: "+56 9 1234 5678" },
    { key: "asistente", label: "Un asistente atiende este canal", ok: true, detail: "Atiende Recepción" },
  ],
};

/** Prisma falso: solo se le pide la lista de canales de WhatsApp de la org. */
function fakePrisma(canales: Array<{ id: string }> = [{ id: "ch1" }]): PrismaService {
  return {
    admin: {
      channelConnection: { findMany: async () => canales, count: async () => canales.length },
      integrationEvent: { findFirst: async () => null },
    },
  } as unknown as PrismaService;
}

const ctxCon = (reporte: Partial<ReporteDeCanal> | null, canales?: Array<{ id: string }>): SetupToolCtx => ({
  organizationId: "org1",
  userId: "u1",
  estado: { reporte: async () => ({ ...REPORTE, ...(reporte ?? {}) }) },
  ...(canales ? {} : {}),
});

const leer = async (ctx: SetupToolCtx, prisma = fakePrisma()) => {
  const r = await runSetupTool(prisma, ctx, "estadoWhatsapp", {});
  return { r, datos: JSON.parse(r!.content) as Record<string, any> };
};

describe("la herramienta estadoWhatsapp existe y es de LECTURA", () => {
  it("está declarada entre las de lectura (no escribe nada en la cuenta)", () => {
    const specs = setupToolSpecs();
    expect(specs.read.map((s) => s.name)).toContain("estadoWhatsapp");
    expect(specs.write.map((s) => s.name)).not.toContain("estadoWhatsapp");
  });

  it("su descripción le dice al modelo CUÁNDO usarla", () => {
    const spec = setupToolSpecs().read.find((s) => s.name === "estadoWhatsapp")!;
    expect(spec.description).toMatch(/qued[óo] conectado|funcionando|no responde/i);
  });
});

describe("número sano", () => {
  it("cuenta número, quién atiende y que no hay nada pendiente", async () => {
    const { datos } = await leer(ctxCon(null));
    expect(datos.conectado).toBe(true);
    expect(datos.canales[0].numero).toBe("+56 9 1234 5678");
    expect(datos.canales[0].atiende).toBe("Recepción");
    expect(datos.canales[0].estado).toBe("activo");
    expect(datos.canales[0].pendientes).toEqual([]);
    expect(datos.resumen).toMatch(/Conectado y atendiendo/i);
  });

  it("ofrece el botón que abre Canales EN MODO DE PRUEBA", async () => {
    const { r } = await leer(ctxCon(null));
    expect(r?.actions).toEqual([{ type: "button", label: "Probar mi WhatsApp", kind: "whatsapp_test" }]);
  });

  it("NINGÚN token ni secreto sale en la respuesta de la herramienta", async () => {
    const { r } = await leer(ctxCon(null));
    expect(r!.content).not.toMatch(/"(access_?token|token|secret|ciphertext|credential\w*)"\s*:/i);
  });
});

describe("número todavía sin publicar (coexistencia recién conectada)", () => {
  it("lo llama «activandose» y trae el qué hacer: nada", async () => {
    const { datos } = await leer(
      ctxCon({
        displayPhone: null,
        pendingNumber: true,
        defaultAgent: null,
        checks: [{ key: "numero", label: "Tu número está publicado en Meta", ok: false, detail: "Meta todavía no publica el número.", fix: "No tienes que hacer nada: esta pantalla se actualiza sola." }],
      }),
    );
    expect(datos.canales[0].estado).toBe("activandose");
    expect(datos.canales[0].pendientes[0]).toEqual({
      que: "Tu número está publicado en Meta",
      explicacion: "Meta todavía no publica el número.",
      comoSeArregla: "No tienes que hacer nada: esta pantalla se actualiza sola.",
    });
  });
});

describe("acceso con Meta vencido", () => {
  it("lo marca como interrumpido (y no como «activo» con un token muerto)", async () => {
    const { datos } = await leer(ctxCon({ tokenHealthy: false, channelStatus: "error" }));
    expect(datos.canales[0].estado).toBe("interrumpido");
  });
});

describe("lo que Meta no contestó NO se cuenta como problema del cliente", () => {
  it("los chequeos «unknown» van a sinComprobar, nunca a pendientes", async () => {
    const { datos } = await leer(
      ctxCon({
        checks: [
          { key: "webhook", label: "Meta nos avisa de tus mensajes", ok: false, unknown: true, detail: "No pudimos comprobarlo ahora." },
          { key: "asistente", label: "Un asistente atiende este canal", ok: false, detail: "Nadie está asignado.", fix: "Asigna tu asistente." },
        ],
      }),
    );
    expect(datos.canales[0].pendientes.map((p: any) => p.que)).toEqual(["Un asistente atiende este canal"]);
    expect(datos.canales[0].sinComprobar).toEqual(["Meta nos avisa de tus mensajes"]);
  });
});

describe("sin canales y sin lector", () => {
  it("sin ningún número conectado ofrece el botón de conectar", async () => {
    const { r, datos } = await leer(ctxCon(null, []), fakePrisma([]));
    expect(datos.conectado).toBe(false);
    expect(r?.actions).toEqual([{ type: "button", label: "Conectar mi WhatsApp", kind: "whatsapp", payload: "coexistencia" }]);
  });

  it("si el lector no está disponible lo dice, sin botón y sin reventar", async () => {
    const { r, datos } = await leer({ organizationId: "org1", userId: "u1" });
    expect(datos.conectado).toBe(false);
    expect(datos.explicacion).toMatch(/no puedo mirar/i);
    expect(r?.actions).toEqual([]);
  });
});

describe("diagnosticarWhatsapp sigue existiendo y ahora usa el MISMO reporte", () => {
  it("un canal activo sin asistente → camino asignar_agente", async () => {
    const r = await runSetupTool(fakePrisma(), ctxCon({ defaultAgent: null }), "diagnosticarWhatsapp", {});
    const d = JSON.parse(r!.content);
    expect(d.camino).toBe("asignar_agente");
    expect(d.numerosConectados).toBe(1);
    expect(d.sinAsistenteAsignado).toBe(1);
  });

  it("el acceso vencido llega como ultimoError, con la frase del reporte", async () => {
    const r = await runSetupTool(
      fakePrisma(),
      ctxCon({
        tokenHealthy: false,
        checks: [{ key: "token", label: "El acceso con Meta está vigente", ok: false, detail: "El acceso con Meta venció o fue revocado, así que tu asistente no puede responder.", fix: "Vuelve a conectar tu WhatsApp." }],
      }),
      "diagnosticarWhatsapp",
      {},
    );
    expect(JSON.parse(r!.content).ultimoError).toMatch(/venció o fue revocado/);
  });
});

describe("el botón de probar sobrevive la validación del servidor", () => {
  it("whatsapp_test es una acción permitida (si no, se caería en silencio)", () => {
    const limpias = sanitizeActions([{ type: "button", label: "Probar mi WhatsApp", kind: "whatsapp_test" }]);
    expect(limpias).toEqual([{ type: "button", label: "Probar mi WhatsApp", kind: "whatsapp_test" }]);
  });
});

describe("el prompt de Convi le dice qué hacer con el estado", () => {
  const svc = new AssistantService({} as never, {} as never);
  const prompt = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    true,
    "/canales",
  );

  it("manda llamar estadoWhatsapp ante las preguntas del dueño", () => {
    expect(prompt).toContain("estadoWhatsapp");
    expect(prompt).toMatch(/qued[óo] conectado/i);
    expect(prompt).toMatch(/por qu[ée] no responde/i);
  });

  it("explica «activandose» como espera, no como error", () => {
    expect(prompt).toMatch(/activandose[\s\S]{0,200}no es un error/i);
  });

  it("prohíbe alarmar con lo que no se pudo comprobar", () => {
    expect(prompt).toMatch(/sinComprobar[\s\S]{0,120}no se lo menciones como problema/i);
  });

  it("ofrece el botón de probar en vez de dictar la ruta", () => {
    expect(prompt).toMatch(/bot[óo]n de probar/i);
  });
});
