import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Importes ESTÁTICOS a propósito: vitest iza los `vi.mock` por encima de los imports, así
// que el doble de base ya está puesto. Con `await import()` dentro de cada test, el costo de
// cargar el grafo del worker se contaba contra el tiempo de la prueba y la volvía inestable.
import { resolveOwnerContext } from "./agent-turn";
import { planDebitsConversation } from "./conversation-credits";
import { descripcionDeAdjunto } from "./messaging-inbound";
import { enviarPorPagina } from "./messaging-send";

/**
 * C3 — RUNTIME DE INSTAGRAM Y MESSENGER.
 *
 * Cuatro cosas que tienen que ser verdad para que estos canales no sean una fuente de
 * sorpresas:
 *  1. Fuera de la ventana de 24 h de Meta no hay nada roto: no se puede escribir primero y
 *     punto. Un flujo no puede caerse por eso.
 *  2. Un adjunto sin texto tiene que llegarle al agente como algo que ENTIENDE, no como
 *     `[image]`.
 *  3. Una respuesta por Instagram se cobra igual que una por WhatsApp (si no, el canal
 *     saldría gratis sin que nadie lo decidiera).
 *  4. Por Instagram/Messenger NADIE hereda el modo dueño, aunque se fije un teléfono.
 */

// ───────────────────────── Estado del doble de base ─────────────────────────
const estado = {
  canal: { id: "ch1", type: "INSTAGRAM", config: { pageId: "p1", igId: "ig1" } } as Record<string, unknown> | null,
  identidad: { externalId: "igsid-123" } as { externalId: string } | null,
  ultimoEntranteMs: Date.now() - 60_000,
  mensajeActualizado: null as Record<string, unknown> | null,
  brand: "conversia",
  features: { conversationDebitsWallet: true } as Record<string, unknown>,
};

vi.mock("@conversia/database", () => ({
  withTenant: async (_org: string, fn: (tx: unknown) => unknown) =>
    fn({
      conversation: { findUnique: async () => ({ id: "cv1", channelConnectionId: "ch1", contactId: "c1" }) },
      channelConnection: { findUnique: async () => estado.canal, findFirst: async () => estado.canal },
      contactIdentity: { findFirst: async () => estado.identidad },
      message: {
        findFirst: async () => (estado.ultimoEntranteMs ? { createdAt: new Date(estado.ultimoEntranteMs) } : null),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          estado.mensajeActualizado = data;
          return data;
        },
      },
    }),
  getAdminPrisma: () => ({
    organization: { findUnique: async () => ({ brand: estado.brand }) },
    subscription: { findFirst: async () => ({ planId: "plan1" }) },
    plan: { findUnique: async () => ({ features: estado.features }) },
  }),
}));

beforeEach(() => {
  estado.canal = { id: "ch1", type: "INSTAGRAM", config: { pageId: "p1", igId: "ig1" } };
  estado.identidad = { externalId: "igsid-123" };
  estado.ultimoEntranteMs = Date.now() - 60_000;
  estado.mensajeActualizado = null;
  estado.brand = "conversia";
  estado.features = { conversationDebitsWallet: true };
});

describe("la ventana de 24 h de Meta no es un error", () => {
  it("fuera de la ventana devuelve «omitido-ventana», no un fallo", async () => {
    estado.ultimoEntranteMs = Date.now() - 25 * 3600 * 1000;
    expect(await enviarPorPagina("org1", "cv1", "m1", "hola")).toBe("omitido-ventana");
    // El mensaje queda marcado con el motivo, para que se entienda en la Bandeja.
    expect(String(estado.mensajeActualizado?.error)).toMatch(/ventana de 24 h/i);
  });

  it("sin ningún mensaje entrante también está fuera de la ventana", async () => {
    estado.ultimoEntranteMs = 0;
    expect(await enviarPorPagina("org1", "cv1", "m1", "hola")).toBe("omitido-ventana");
  });

  it("sin identidad de la red se distingue de la ventana (es otro problema)", async () => {
    estado.identidad = null;
    expect(await enviarPorPagina("org1", "cv1", "m1", "hola")).toBe("sin-identidad");
  });

  it("en un canal que NO es de redes no se mete", async () => {
    estado.canal = { id: "ch1", type: "WHATSAPP_CLOUD", config: {} };
    expect(await enviarPorPagina("org1", "cv1", "m1", "hola")).toBe("no-aplica");
  });
});

describe("un adjunto sin texto le llega al agente en castellano y con qué hacer", () => {
  it.each([
    ["image", /una foto/],
    ["audio", /un audio/],
    ["video", /un video/],
    ["file", /un archivo/],
    ["share", /algo que compartió/],
  ])("%s → %s", async (tipo, esperado) => {
    expect(descripcionDeAdjunto(tipo)).toMatch(esperado);
  });

  it("le dice al agente que NO puede verlo y que pida el detalle por escrito", async () => {
    const d = descripcionDeAdjunto("image");
    expect(d).toMatch(/no puedes verlo/i);
    expect(d).toMatch(/por escrito/i);
    // Nada de `[image]`: eso no le dice nada a nadie.
    expect(d).not.toBe("[image]");
  });

  it("un tipo que Meta invente igual se cuenta como archivo", async () => {
    expect(descripcionDeAdjunto("holograma")).toMatch(/un archivo/);
    expect(descripcionDeAdjunto(null)).toMatch(/un archivo/);
  });
});

describe("responder por Instagram se cobra igual que por WhatsApp", () => {
  it("el cobro depende de la ORG y su plan, no del canal", async () => {
    // Misma org conversia con cobro por conversación: la respuesta se cobra, venga de
    // donde venga. Si alguien atara el cobro al canal, Instagram saldría gratis sin que
    // nadie lo hubiera decidido.
    expect(await planDebitsConversation("org1")).toBe(true);
  });

  it("en una org de TuBot no se cobra por conversación (ni por Instagram)", async () => {
    estado.brand = "tubot";
    expect(await planDebitsConversation("org1")).toBe(false);
  });
});

describe("el modo dueño NO se hereda por Instagram ni Messenger", () => {
  const tx = {
    channelConnection: { findFirst: async () => estado.canal },
    contactIdentity: { findFirst: async () => estado.identidad },
    role: { findMany: async () => [{ id: "r1" }] },
    organizationUser: { findMany: async () => [{ user: { phone: "+56911111111" } }] },
  };

  it.each(["INSTAGRAM", "MESSENGER"])("por %s siempre es false, aunque el contacto tenga teléfono", async (tipo) => {
    estado.canal = { id: "ch1", type: tipo, config: {} };
    // La identidad trae justo el teléfono del dueño: aun así, no hay modo dueño.
    estado.identidad = { externalId: "+56911111111" };
    expect(await resolveOwnerContext(tx as never, { organizationId: "org1", contactId: "c1", channelConnectionId: "ch1" })).toBe(false);
  });

  it("sin canal tampoco", async () => {
    expect(await resolveOwnerContext(tx as never, { organizationId: "org1", contactId: "c1", channelConnectionId: null })).toBe(false);
  });
});

describe("el flujo no se cae por un canal de redes (guardián de código)", () => {
  /**
   * `sendText` del motor de flujos llamaba derecho a `resolveChannelAuth`, que no encuentra
   * un canal de WhatsApp para un contacto de Instagram y LANZA: el flujo entero se caía por
   * un recordatorio que no se podía mandar. El orden importa, así que se vigila el orden.
   */
  it("sendText atiende al contacto SIN teléfono antes de resolver el canal de WhatsApp", async () => {
    const src = readFileSync(join(__dirname, "workflow-runtime.ts"), "utf8");
    const i = src.indexOf("async sendText");
    // SIN comentarios: el comentario que explica el arreglo nombra `resolveChannelAuth`, y
    // un guardián que mire comentarios mide la prosa, no el código.
    const tramo = src
      .slice(i, src.indexOf("async runAgent", i))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ 	]*\/\/.*$/gm, "");
    expect(tramo.length).toBeGreaterThan(300);
    const sinTelefono = tramo.indexOf("if (!data.phone)");
    const resolver = tramo.indexOf("resolveChannelAuth");
    expect(sinTelefono, "sendText ya no desvía los canales de redes").toBeGreaterThan(-1);
    expect(sinTelefono, "la resolución del canal de WhatsApp quedó ANTES: volvería a lanzar").toBeLessThan(resolver);
    expect(tramo).toContain("enviarPorPagina");
    expect(tramo).toMatch(/messaging\.omitido/);
  });

  it("sendTemplate deja constancia cuando omite (antes se salía en silencio)", async () => {
    const src = readFileSync(join(__dirname, "workflow-runtime.ts"), "utf8");
    const i = src.indexOf("async sendTemplate");
    const tramo = src.slice(i, i + 4000);
    expect(tramo).toMatch(/messaging\.omitido/);
    expect(tramo).toMatch(/no admiten plantillas/i);
  });
});
