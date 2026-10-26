import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// El router de IA se mockea para no llamar a ningún proveedor: devuelve texto real determinista.
const chatMock = vi.fn(async () => ({ stopReason: "end", text: "Hola, te ayudo con tu asistente 👋", toolCalls: [] }));
const providerMock = vi.fn((_opts?: unknown) => ({ chat: chatMock }));
// Spread del módulo real (agent-qa y otros importan de aquí) y sobrescribe SOLO createAIProvider.
vi.mock("@conversia/agents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAIProvider: (opts: unknown) => providerMock(opts),
}));

import { AssistantService } from "./assistant.service";

/**
 * Bloque 3 — si buildContext falla (consulta de BD caída), el turno degrada a un contexto mínimo
 * y responde 200 con texto real de la IA, nunca un 500 con el fallback genérico. Registra
 * `✖ Asistente: contexto` en el log, igual que el fallo del proveedor de IA.
 */
describe("AssistantService.run — degradación de contexto (Bloque 3)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { chatMock.mockClear(); providerMock.mockClear(); errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => errSpy.mockRestore());

  it("buildContext que lanza → responde con la IA (200) y loguea el error de contexto", async () => {
    // prisma falso: la PRIMERA consulta de buildContext (organization.findUnique) revienta.
    const prisma = { admin: { organization: { findUnique: vi.fn(async () => { throw new Error("db down"); }) } } } as any;
    const svc = new AssistantService(prisma);

    const out = await svc.run({ organizationId: "org1", userId: "u1", role: "owner" }, "hola", []);

    expect(out.reply).toBe("Hola, te ayudo con tu asistente 👋"); // texto real de la IA, no el fallback
    expect(out.wrote).toBe(false);
    expect(chatMock).toHaveBeenCalledTimes(1); // la IA sí corrió pese al contexto caído
    expect(errSpy.mock.calls.flat().some((a) => String(a).includes("✖ Asistente: contexto"))).toBe(true);
    // El proveedor se elige por AI_PROVIDER configurado (no por ruteo de modelo) → nunca cae a un
    // OpenAI roto cuando el dueño configuró anthropic (hallazgo prod 26-oct).
    expect(providerMock).toHaveBeenCalledWith(expect.objectContaining({ provider: expect.any(String) }));
  });
});
