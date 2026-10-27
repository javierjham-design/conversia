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

// tx falso: solo necesita agent.findMany. `seen` captura el `where` para poder verificar
// que la consulta lleva el filtro EXPLÍCITO de organización (auditoría etapa 2).
function fakeTx(
  agents: Array<{ id: string; slug: string; name: string; active: boolean }>,
  seen?: { where?: Record<string, unknown> },
) {
  return {
    agent: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        if (seen) seen.where = args?.where;
        return agents;
      },
    },
  } as never;
}

const ORG = "org-A";
const AGENTS = [
  { id: "a1", slug: "recepcion-digital-dent", name: "Recepción Digital Dent", active: true },
  { id: "a2", slug: "resp-implantes", name: "RESP IMPLANTES", active: true },
  { id: "a3", slug: "resp-ortodoncia", name: "Resp Ortodoncia", active: false },
];

describe("resolveAgentByNameOrSlug — derivar a un AGENTE (no equipo ni persona)", () => {
  it("resuelve por NOMBRE visible", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "RESP IMPLANTES", ORG);
    expect(r?.slug).toBe("resp-implantes");
  });
  it("resuelve por MENCIÓN @Nombre", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "@RESP IMPLANTES", ORG);
    expect(r?.slug).toBe("resp-implantes");
  });
  it("resuelve por SLUG", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "resp-implantes", ORG);
    expect(r?.id).toBe("a2");
  });
  it("insensible a acentos/mayúsculas", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "recepción digital dent", ORG);
    expect(r?.slug).toBe("recepcion-digital-dent");
  });
  it("devuelve el agente aunque esté inactivo (el caller decide)", async () => {
    const r = await resolveAgentByNameOrSlug(fakeTx(AGENTS), "resp ortodoncia", ORG);
    expect(r?.active).toBe(false);
  });
  it("null si no es ningún agente (p. ej. un equipo/persona)", async () => {
    expect(await resolveAgentByNameOrSlug(fakeTx(AGENTS), "Ventas", ORG)).toBeNull();
    expect(await resolveAgentByNameOrSlug(fakeTx(AGENTS), "", ORG)).toBeNull();
  });

  // Auditoría etapa 2: la derivación jamás debe poder resolver al agente de otro cliente.
  it("acota la búsqueda a la organización (filtro explícito, no solo RLS)", async () => {
    const seen: { where?: Record<string, unknown> } = {};
    await resolveAgentByNameOrSlug(fakeTx(AGENTS, seen), "resp-implantes", ORG);
    expect(seen.where?.organizationId).toBe(ORG);
    expect(seen.where?.deletedAt).toBeNull();
  });
});
