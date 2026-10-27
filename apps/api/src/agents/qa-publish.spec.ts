import { describe, expect, it, vi, beforeEach } from "vitest";
import { ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";

// La batería de auto-QA se mockea: no se llama a ningún proveedor de IA en los tests.
const qaMock = vi.fn();
vi.mock("./agent-qa", () => ({ runQaBattery: (...args: unknown[]) => qaMock(...args) }));

import { AgentsController } from "./agents.controller";
import { runWithContext, type RequestContext } from "../tenancy/context";

/**
 * ETAPA 0 (hallazgo 1) — POST /agents/:id/qa-publish: el CLIENTE (owner/admin) corre la batería
 * y publica. Si la batería falla, no se publica y el mensaje tiene que entenderlo un dueño de
 * negocio, no un programador. Todo intento queda auditado.
 */

function makePrisma(opts: { channels?: { id: string; defaultAgentId: string | null }[]; published?: boolean } = {}) {
  const channels = opts.channels ?? [{ id: "ch1", defaultAgentId: null }];
  const audit: any[] = [];
  const calls = { updateMany: 0 };
  const tx = {
    agent: { findFirst: async () => ({ id: "ag1", name: "Recepción" }) },
    agentVersion: {
      findMany: async () => (opts.published === false ? [] : [{ agentId: "ag1", version: 1, publishedAt: new Date() }]),
    },
    channelConnection: {
      findMany: async () => channels.filter((c) => c.defaultAgentId === null).map((c) => ({ id: c.id })),
      updateMany: async ({ where, data }: any) => {
        calls.updateMany++;
        const ids = new Set<string>(where.id.in);
        let count = 0;
        for (const c of channels) if (ids.has(c.id) && c.defaultAgentId === null) { c.defaultAgentId = data.defaultAgentId; count++; }
        return { count };
      },
    },
    auditLog: { create: async ({ data }: any) => { audit.push(data); return data; } },
  };
  const prisma: any = {
    admin: { organization: { findUnique: async () => ({ brand: "conversia" }) } },
    withTenant: (_org: string, fn: any) => fn(tx),
  };
  return { prisma, channels, audit, calls };
}

const rateLimit = (allowed = true): any => ({ custom: vi.fn(async () => ({ allowed, count: 1, retryAfterSeconds: 300 })) });
const ctx = (permissions: string[]): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions });

describe("AgentsController.qaPublish — publicación en el flujo del cliente", () => {
  beforeEach(() => qaMock.mockReset());

  it("batería ROJA → no publica y explica en lenguaje simple qué falló", async () => {
    qaMock.mockResolvedValue({
      ok: true,
      passed: false,
      published: false,
      corrected: false,
      results: [
        { name: "ofrece agendar", pass: false, reason: "no ofreció agendar" },
        { name: "no inventa precios (regla 3)", pass: false, reason: "inventó un precio que no está en el catálogo" },
        { name: "responde (una respuesta por turno)", pass: true },
      ],
    });
    const { prisma, channels, audit, calls } = makePrisma();
    const c = new AgentsController(prisma, rateLimit());

    const r: any = await runWithContext(ctx(["agents:write"]), () => c.qaPublish("ag1"));

    expect(r.published).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.mensaje).toMatch(/no publicamos tu asistente/i);
    expect(r.problemas).toHaveLength(2);
    expect(r.problemas[0].titulo).toBe("No ofreció agendar una hora");
    expect(r.problemas[1].titulo).toBe("Dijo un precio que no está en tu lista");
    expect(r.problemas[0].comoArreglarlo.length).toBeGreaterThan(20);
    // Lenguaje de dueño de negocio: nada de jerga técnica en lo que se le muestra.
    const visible = [r.mensaje, ...r.problemas.map((p: any) => `${p.titulo} ${p.queSignifica} ${p.comoArreglarlo}`)].join(" ");
    expect(visible).not.toMatch(/assert|scenario|payload|endpoint|null|undefined|regla 3|systemPrompt/i);
    // Si no pasó, NO se toca ningún canal.
    expect(calls.updateMany).toBe(0);
    expect(channels[0].defaultAgentId).toBeNull();
    // Queda auditado el intento fallido, con el detalle técnico para soporte.
    const qaAudit = audit.filter((a) => a.action === "agent.qa_publish");
    expect(qaAudit).toHaveLength(1);
    expect(qaAudit[0].after).toMatchObject({ passed: false, published: false });
    expect(qaAudit[0].after.fallos).toEqual(["ofrece agendar", "no inventa precios (regla 3)"]);
    expect(r.escenarios).toHaveLength(3);
  });

  it("batería VERDE → publica con autoPublish, audita y asigna el agente a los canales", async () => {
    qaMock.mockResolvedValue({
      ok: true,
      passed: true,
      published: true,
      corrected: false,
      results: [{ name: "ofrece agendar", pass: true }],
    });
    const { prisma, channels, audit } = makePrisma();
    const c = new AgentsController(prisma, rateLimit());

    const r: any = await runWithContext(ctx(["agents:write"]), () => c.qaPublish("ag1"));

    expect(qaMock).toHaveBeenCalledWith(prisma, "org1", "ag1", { autoPublish: true });
    expect(r).toMatchObject({ ok: true, passed: true, published: true });
    expect(r.mensaje).toMatch(/publicado/i);
    expect(r.problemas).toEqual([]);
    // El agente recién publicado queda como predeterminado del canal que no tenía ninguno.
    expect(channels[0].defaultAgentId).toBe("ag1");
    expect(r.canalesAsignados).toBe(1);
    expect(audit.some((a) => a.action === "channel.agent_auto_assigned")).toBe(true);
    const qaAudit = audit.find((a) => a.action === "agent.qa_publish");
    expect(qaAudit.actorId).toBe("u1");
    expect(qaAudit.after).toMatchObject({ passed: true, published: true, fallos: [] });
  });

  it("batería verde dos veces: la segunda no vuelve a asignar (idempotente)", async () => {
    qaMock.mockResolvedValue({ ok: true, passed: true, published: true, corrected: false, results: [] });
    const { prisma, channels, audit } = makePrisma();
    const c = new AgentsController(prisma, rateLimit());

    const first: any = await runWithContext(ctx(["agents:write"]), () => c.qaPublish("ag1"));
    const second: any = await runWithContext(ctx(["agents:write"]), () => c.qaPublish("ag1"));

    expect(first.canalesAsignados).toBe(1);
    expect(second.canalesAsignados).toBe(0);
    expect(channels[0].defaultAgentId).toBe("ag1");
    expect(audit.filter((a) => a.action === "channel.agent_auto_assigned")).toHaveLength(1);
  });

  it("sin versión guardada → mensaje entendible, no un error técnico", async () => {
    qaMock.mockResolvedValue({ ok: false, passed: false, published: false, corrected: false, results: [], error: "sin versión del agente" });
    const { prisma, audit } = makePrisma();
    const c = new AgentsController(prisma, rateLimit());

    const r: any = await runWithContext(ctx(["agents:write"]), () => c.qaPublish("ag1"));

    expect(r.published).toBe(false);
    expect(r.mensaje).toMatch(/todavía no tiene instrucciones guardadas/i);
    expect(r.problemas[0].titulo).toBe("No pudimos terminar la prueba");
    expect(audit.filter((a) => a.action === "agent.qa_publish")).toHaveLength(1);
  });

  it("exige agents:write (un 'Solo lectura' no publica el bot)", async () => {
    const { prisma } = makePrisma();
    const c = new AgentsController(prisma, rateLimit());
    await expect(runWithContext(ctx(["agents:read"]), () => c.qaPublish("ag1"))).rejects.toBeInstanceOf(ForbiddenException);
    expect(qaMock).not.toHaveBeenCalled();
  });

  it("corta con 429 si el cliente la dispara en loop (la batería gasta tokens reales)", async () => {
    const { prisma } = makePrisma();
    const c = new AgentsController(prisma, rateLimit(false));
    await expect(runWithContext(ctx(["agents:write"]), () => c.qaPublish("ag1"))).rejects.toBeInstanceOf(HttpException);
    expect(qaMock).not.toHaveBeenCalled();
  });

  it("agente de otra cuenta / inexistente → 404 (el orgId sale del JWT)", async () => {
    const { prisma } = makePrisma();
    prisma.withTenant = (_org: string, fn: any) => fn({ agent: { findFirst: async () => null } });
    const c = new AgentsController(prisma, rateLimit());
    await expect(runWithContext(ctx(["agents:write"]), () => c.qaPublish("ajeno"))).rejects.toBeInstanceOf(NotFoundException);
    expect(qaMock).not.toHaveBeenCalled();
  });
});
