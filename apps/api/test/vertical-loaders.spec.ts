import { beforeEach, describe, expect, it } from "vitest";
import { loadAgents } from "@conversia/database";

// Mock mínimo del cliente Prisma: captura lo que escriben los loaders.
function makeDb() {
  const state = { versions: [] as any[], agentUpdates: 0 };
  const db: any = {
    agent: {
      upsert: async () => ({ id: "agent1" }),
      update: async () => {
        state.agentUpdates++;
      },
    },
    agentVersion: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        state.versions.push(data);
        return { id: "ver1", ...data };
      },
    },
  };
  return { db, state };
}

const AGENTS = [{ slug: "recepcion", name: "Recepción", description: "d", systemPrompt: "prompt", config: {}, tools: [] }];

describe("loadAgents (publish flag — paquete vertical vs seed)", () => {
  let fx: ReturnType<typeof makeDb>;
  beforeEach(() => {
    fx = makeDb();
  });

  it("paquete vertical (publish:false) → versión BORRADOR, sin activar el agente", async () => {
    const bySlug = await loadAgents(fx.db, "org1", AGENTS, { publish: false });
    expect(bySlug.recepcion).toBe("agent1");
    expect(fx.state.versions).toHaveLength(1);
    expect(fx.state.versions[0].status).toBe("DRAFT");
    expect(fx.state.versions[0].publishedAt).toBeNull();
    expect(fx.state.agentUpdates).toBe(0); // no se fija currentVersionId en borrador
  });

  it("seed (publish:true) → versión PUBLICADA y agente activado", async () => {
    await loadAgents(fx.db, "org1", AGENTS, { publish: true });
    expect(fx.state.versions[0].status).toBe("PUBLISHED");
    expect(fx.state.versions[0].publishedAt).toBeInstanceOf(Date);
    expect(fx.state.agentUpdates).toBe(1);
  });
});
