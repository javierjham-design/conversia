import { describe, expect, it } from "vitest";
import { normalizeAgentKey, resolveAgentByNameOrSlug } from "@conversia/database";

// El bug: Recepción debía derivar a RESP IMPLANTES (otro AGENTE de IA), pero el destino se
// buscaba solo por slug y los prompts usan el nombre visible "@RESP IMPLANTES". Estos tests
// cubren que la resolución acepte nombre O slug, insensible a mayúsculas/acentos/guiones.

describe("normalizeAgentKey", () => {
  it("iguala nombre visible, slug y mención", () => {
    const k = normalizeAgentKey("RESP IMPLANTES");
    expect(normalizeAgentKey("resp-implantes")).toBe(k);
    expect(normalizeAgentKey("@RESP IMPLANTES")).toBe(k);
    expect(normalizeAgentKey("  Resp   Implantes ")).toBe(k);
  });
  it("quita acentos", () => {
    expect(normalizeAgentKey("Agéndamé")).toBe("agendame");
  });
});

// tx falso: solo necesita agent.findMany (RLS ya acota por org en producción).
function fakeTx(agents: Array<{ id: string; slug: string; name: string; active: boolean }>) {
  return { agent: { findMany: async () => agents } } as never;
}

const AGENTS = [
  { id: "a1", slug: "recepcion-digital-dent", name: "Recepción Digital Dent", active: true },
  { id: "a2", slug: "resp-implantes", name: "RESP IMPLANTES", active: true },
  { id: "a3", slug: "resp-ortodoncia", name: "Resp Ortodoncia", active: false },
];

describe("resolveAgentByNameOrSlug — derivar a un AGENTE (no equipo ni persona)", () => {
  it("resuelve por NOMBRE visible", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "RESP IMPLANTES");
    expect(r?.slug).toBe("resp-implantes");
  });
  it("resuelve por MENCIÓN @Nombre", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "@RESP IMPLANTES");
    expect(r?.slug).toBe("resp-implantes");
  });
  it("resuelve por SLUG", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "resp-implantes");
    expect(r?.id).toBe("a2");
  });
  it("insensible a acentos/mayúsculas", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "recepción digital dent");
    expect(r?.slug).toBe("recepcion-digital-dent");
  });
  it("devuelve el agente aunque esté inactivo (el caller decide)", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "resp ortodoncia");
    expect(r?.active).toBe(false);
  });
  it("null si no es ningún agente (p. ej. un equipo/persona)", async () => {
    expect(await resolveAgentByNameOrSlug(fakeTx(AGENTS), "Ventas")).toBeNull();
    expect(await resolveAgentByNameOrSlug(fakeTx(AGENTS), "")).toBeNull();
  });
});
