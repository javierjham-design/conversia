import { describe, expect, it, vi, beforeEach } from "vitest";

// El probador del agente se mockea: ningún proveedor de IA se llama en los tests.
const testMock = vi.fn();
vi.mock("./agent-test", () => ({ runAgentTest: (...args: unknown[]) => testMock(...args) }));

import { runQaBattery } from "./agent-qa";

/**
 * ETAPA 0 — garantía dura de la publicación del cliente: con `autoPublish: true`, la batería
 * publica SOLO si está toda verde. Si un escenario falla (ni siquiera tras la autocorrección),
 * el borrador se queda borrador. Al publicar, queda auditado.
 */

function makePrisma() {
  const draft = { id: "v1", agentId: "ag1", version: 3, status: "DRAFT", systemPrompt: "Eres el asistente.", config: {}, tools: [] };
  const updates: any[] = [];
  const agentUpdates: any[] = [];
  const audit: any[] = [];
  const tx = {
    agentVersion: {
      findFirst: async ({ where }: any) => (where.status === "DRAFT" ? draft : null),
      update: async ({ where, data }: any) => { updates.push({ where, data }); return { ...draft, ...data }; },
    },
    agent: { update: async ({ where, data }: any) => { agentUpdates.push({ where, data }); return {}; } },
    auditLog: { create: async ({ data }: any) => { audit.push(data); return data; } },
  };
  const prisma: any = { withTenant: (_org: string, fn: any) => fn(tx), admin: {} };
  return { prisma, updates, agentUpdates, audit };
}

const GOOD_REPLY =
  "Con gusto te puedo agendar una hora. Si es una urgencia, te paso de inmediato con una persona del equipo. " +
  "Ese valor no lo tengo a mano y te lo confirmamos a la brevedad.";

describe("runQaBattery con autoPublish — publica solo con la batería verde", () => {
  beforeEach(() => testMock.mockReset());

  it("batería ROJA → NO publica (el borrador sigue borrador) y dice qué escenarios fallaron", async () => {
    // Respuesta mala a propósito: inventa precio, no ofrece agendar y no deriva la urgencia.
    testMock.mockResolvedValue({ ok: true, reply: "Son $45.000 exactos, nada más.", humanHandoff: false, toolEvents: [] });
    const { prisma, updates, agentUpdates, audit } = makePrisma();

    const r = await runQaBattery(prisma, "org1", "ag1", { autoPublish: true });

    expect(r.passed).toBe(false);
    expect(r.published).toBe(false);
    expect(updates).toHaveLength(0); // ni publicó ni guardó la autocorrección
    expect(agentUpdates).toHaveLength(0);
    expect(audit).toHaveLength(0);
    const fallos = r.results.filter((x) => !x.pass).map((x) => x.name);
    expect(fallos).toContain("ofrece agendar");
    expect(fallos).toContain("no inventa precios (regla 3)");
  });

  it("batería VERDE → publica el borrador, lo deja como versión vigente y lo AUDITA", async () => {
    testMock.mockResolvedValue({ ok: true, reply: GOOD_REPLY, humanHandoff: true, toolEvents: [] });
    const { prisma, updates, agentUpdates, audit } = makePrisma();

    const r = await runQaBattery(prisma, "org1", "ag1", { autoPublish: true });

    expect(r.passed).toBe(true);
    expect(r.published).toBe(true);
    expect(updates[0].data).toMatchObject({ status: "PUBLISHED" });
    expect(updates[0].data.publishedAt).toBeInstanceOf(Date);
    expect(agentUpdates[0].where).toEqual({ id: "ag1" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: "org1", action: "agent.publish", entityType: "agent", entityId: "ag1" });
  });
});
