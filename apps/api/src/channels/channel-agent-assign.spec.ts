import { describe, expect, it, vi } from "vitest";

// Los límites del plan no son el objeto de este test (piden suscripción/entitlements reales).
vi.mock("../common/plan-limits", () => ({
  enforcePlanLimit: async () => undefined,
  getTemplatesEntitlement: async () => ({ planAllows: false, switchOn: false, enabled: false }),
}));

import { ChannelsController } from "./channels.controller";
import { runWithContext, type RequestContext } from "../tenancy/context";

/**
 * ETAPA 0 (hallazgo 2) — al CONECTAR el canal, si la org ya tiene un agente publicado y el
 * canal quedó sin agente por defecto, se asigna solo. Antes el número quedaba conectado y
 * nadie respondía. Los caminos de Embedded Signup y coexistencia llaman exactamente a la
 * misma función (assignPublishedAgentToChannelsSafe) justo después de persistir el canal.
 */

function makePrisma(opts: { brand?: string; published?: boolean } = {}) {
  const channels: { id: string; defaultAgentId: string | null; status: string; name: string }[] = [];
  const audit: any[] = [];
  const tx = {
    channelConnection: {
      count: async () => channels.length,
      create: async ({ data }: any) => {
        const ch = { id: `ch${channels.length + 1}`, defaultAgentId: data.defaultAgentId ?? null, status: data.status, name: data.name };
        channels.push(ch);
        return ch;
      },
      findMany: async () => channels.filter((c) => c.defaultAgentId === null && c.status !== "inactive").map((c) => ({ id: c.id })),
      updateMany: async ({ where, data }: any) => {
        const ids = new Set<string>(where.id.in);
        let count = 0;
        for (const c of channels) if (ids.has(c.id) && c.defaultAgentId === null) { c.defaultAgentId = data.defaultAgentId; count++; }
        return { count };
      },
    },
    agentVersion: {
      findMany: async () => (opts.published === false ? [] : [{ agentId: "ag1", version: 2, publishedAt: new Date() }]),
    },
    auditLog: { create: async ({ data }: any) => { audit.push(data); return data; } },
  };
  const prisma: any = {
    admin: { organization: { findUnique: async () => ({ brand: opts.brand ?? "conversia" }) } },
    withTenant: (_org: string, fn: any) => fn(tx),
  };
  return { prisma, channels, audit };
}

const ctx = (permissions: string[]): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions });

describe("ChannelsController.create — agente asignado al conectar", () => {
  it("canal nuevo sin agente + agente publicado → se asigna solo y queda auditado", async () => {
    const { prisma, channels, audit } = makePrisma();
    const c = new ChannelsController(prisma);

    await runWithContext(ctx(["channels:write"]), () => c.create({ type: "MOCK", name: "Canal de prueba" }));

    expect(channels).toHaveLength(1);
    expect(channels[0].defaultAgentId).toBe("ag1");
    expect(audit.map((a) => a.action)).toContain("channel.agent_auto_assigned");
  });

  it("si el cliente eligió el agente, se respeta (no se pisa)", async () => {
    const { prisma, channels, audit } = makePrisma();
    const c = new ChannelsController(prisma);

    await runWithContext(ctx(["channels:write"]), () =>
      c.create({ type: "MOCK", name: "Canal de prueba", defaultAgentId: "el-que-eligio" }),
    );

    expect(channels[0].defaultAgentId).toBe("el-que-eligio");
    expect(audit.map((a) => a.action)).not.toContain("channel.agent_auto_assigned");
  });

  it("org sin agente publicado: el canal se crea igual, sin agente y sin error", async () => {
    const { prisma, channels, audit } = makePrisma({ published: false });
    const c = new ChannelsController(prisma);

    const r: any = await runWithContext(ctx(["channels:write"]), () => c.create({ type: "MOCK", name: "Canal de prueba" }));

    expect(r.id).toBe("ch1");
    expect(channels[0].defaultAgentId).toBeNull();
    expect(audit.map((a) => a.action)).not.toContain("channel.agent_auto_assigned");
  });

  it("TuBot intacto: en una org de marca tubot el canal se crea como siempre, sin asignar nada", async () => {
    const { prisma, channels, audit } = makePrisma({ brand: "tubot" });
    const c = new ChannelsController(prisma);

    await runWithContext(ctx(["channels:write"]), () => c.create({ type: "MOCK", name: "Canal de prueba" }));

    expect(channels[0].defaultAgentId).toBeNull();
    expect(audit.map((a) => a.action)).toEqual(["channel.create"]);
  });
});
