import { describe, expect, it, vi } from "vitest";
import {
  assignPublishedAgentToChannels,
  assignPublishedAgentToChannelsSafe,
} from "./assign-agent-to-channels";

/**
 * ETAPA 0 (hallazgo 2) — el canal se creaba sin agente asignado: número conectado y NADIE
 * respondiendo. Estos tests fijan el contrato: asigna solo agentes PUBLICADOS, nunca pisa el
 * agente que eligió el cliente, es idempotente y para TuBot (marca ≠ conversia) no hace nada.
 */

type FakeVersion = { agentId: string; version: number; publishedAt: Date | null; status: string; agentActive?: boolean; agentDeleted?: boolean };
type FakeChannel = { id: string; defaultAgentId: string | null; status?: string; createdAt?: Date };

function makePrisma(opts: { brand?: string; versions?: FakeVersion[]; channels?: FakeChannel[] } = {}) {
  const versions = opts.versions ?? [];
  const channels = opts.channels ?? [];
  const audit: any[] = [];
  const calls = { withTenant: 0, updateMany: 0 };

  const tx = {
    agentVersion: {
      findMany: async ({ where }: any) =>
        versions
          .filter((v) => v.status === where.status)
          .filter((v) => v.agentActive !== false && v.agentDeleted !== true)
          .map((v) => ({ agentId: v.agentId, version: v.version, publishedAt: v.publishedAt })),
    },
    channelConnection: {
      findMany: async () =>
        channels.filter((c) => c.defaultAgentId === null && (c.status ?? "active") !== "inactive").map((c) => ({ id: c.id })),
      updateMany: async ({ where, data }: any) => {
        calls.updateMany++;
        const ids = new Set<string>(where.id.in);
        let count = 0;
        for (const c of channels) {
          // El fake respeta el filtro `defaultAgentId: null` del where (a prueba de carreras).
          if (ids.has(c.id) && c.defaultAgentId === null) {
            c.defaultAgentId = data.defaultAgentId;
            count++;
          }
        }
        return { count };
      },
    },
    auditLog: { create: async ({ data }: any) => { audit.push(data); return data; } },
  };

  const prisma: any = {
    admin: { organization: { findUnique: async () => ({ brand: opts.brand ?? "conversia" }) } },
    withTenant: (_org: string, fn: any) => { calls.withTenant++; return fn(tx); },
  };
  return { prisma, channels, audit, calls };
}

const pub = (agentId: string, version = 1, publishedAt: Date | null = new Date("2026-10-27T10:00:00Z")): FakeVersion => ({
  agentId,
  version,
  publishedAt,
  status: "PUBLISHED",
});

describe("assignPublishedAgentToChannels — asignación automática del agente al canal", () => {
  it("asigna el agente publicado al canal que no tiene agente (y lo audita)", async () => {
    const { prisma, channels, audit } = makePrisma({ versions: [pub("ag1")], channels: [{ id: "ch1", defaultAgentId: null }] });

    const r = await assignPublishedAgentToChannels(prisma, "org1", { actorId: "u1" });

    expect(r.assigned).toBe(1);
    expect(r.agentId).toBe("ag1");
    expect(r.channelIds).toEqual(["ch1"]);
    expect(channels[0].defaultAgentId).toBe("ag1");
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("channel.agent_auto_assigned");
    expect(audit[0].actorId).toBe("u1");
    expect(audit[0].after).toMatchObject({ agentId: "ag1", channelIds: ["ch1"] });
  });

  it("NO pisa el defaultAgentId que ya puso el cliente", async () => {
    const { prisma, channels, audit, calls } = makePrisma({
      versions: [pub("ag1")],
      channels: [{ id: "ch1", defaultAgentId: "elegido-por-el-cliente" }],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1");

    expect(r.assigned).toBe(0);
    expect(r.reason).toBe("sin-canales-pendientes");
    expect(channels[0].defaultAgentId).toBe("elegido-por-el-cliente");
    expect(calls.updateMany).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("es IDEMPOTENTE: correrla dos veces no cambia nada ni vuelve a auditar", async () => {
    const { prisma, channels, audit } = makePrisma({ versions: [pub("ag1")], channels: [{ id: "ch1", defaultAgentId: null }] });

    const first = await assignPublishedAgentToChannels(prisma, "org1");
    const second = await assignPublishedAgentToChannels(prisma, "org1");

    expect(first.assigned).toBe(1);
    expect(second.assigned).toBe(0);
    expect(second.reason).toBe("sin-canales-pendientes");
    expect(channels[0].defaultAgentId).toBe("ag1");
    expect(audit).toHaveLength(1);
  });

  it("una org SIN agente publicado (solo borrador) no rompe ni asigna nada", async () => {
    const { prisma, channels, audit } = makePrisma({
      versions: [{ agentId: "ag1", version: 1, publishedAt: null, status: "DRAFT" }],
      channels: [{ id: "ch1", defaultAgentId: null }],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1");

    expect(r).toMatchObject({ assigned: 0, agentId: null, reason: "sin-agente-publicado" });
    expect(channels[0].defaultAgentId).toBeNull();
    expect(audit).toHaveLength(0);
  });

  it("TuBot intacto: con marca distinta de conversia ni abre la transacción", async () => {
    const { prisma, channels, calls } = makePrisma({
      brand: "tubot",
      versions: [pub("ag1")],
      channels: [{ id: "ch1", defaultAgentId: null }],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1");

    expect(r).toMatchObject({ assigned: 0, reason: "marca-no-conversia" });
    expect(calls.withTenant).toBe(0);
    expect(channels[0].defaultAgentId).toBeNull();
  });

  it("prefiere el agente que se acaba de publicar (preferAgentId)", async () => {
    const { prisma, channels } = makePrisma({
      versions: [pub("viejo", 3, new Date("2026-10-01T10:00:00Z")), pub("nuevo", 1, new Date("2026-10-20T10:00:00Z"))],
      channels: [{ id: "ch1", defaultAgentId: null }],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1", { preferAgentId: "viejo" });

    expect(r.agentId).toBe("viejo");
    expect(channels[0].defaultAgentId).toBe("viejo");
  });

  it("sin preferencia elige el de publicación más reciente; ignora borrados/inactivos", async () => {
    const { prisma, channels } = makePrisma({
      versions: [
        pub("antiguo", 1, new Date("2026-09-01T10:00:00Z")),
        pub("reciente", 1, new Date("2026-10-26T10:00:00Z")),
        { ...pub("borrado", 9, new Date("2026-10-27T10:00:00Z")), agentDeleted: true },
        { ...pub("apagado", 9, new Date("2026-10-27T11:00:00Z")), agentActive: false },
      ],
      channels: [{ id: "ch1", defaultAgentId: null }],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1");

    expect(r.agentId).toBe("reciente");
    expect(channels[0].defaultAgentId).toBe("reciente");
  });

  it("un preferAgentId sin versión publicada se ignora (nunca asigna un borrador)", async () => {
    const { prisma, channels } = makePrisma({
      versions: [pub("publicado")],
      channels: [{ id: "ch1", defaultAgentId: null }],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1", { preferAgentId: "solo-borrador" });

    expect(r.agentId).toBe("publicado");
    expect(channels[0].defaultAgentId).toBe("publicado");
  });

  it("rellena TODOS los canales pendientes y deja en paz los inactivos y los ya asignados", async () => {
    const { prisma, channels } = makePrisma({
      versions: [pub("ag1")],
      channels: [
        { id: "ch1", defaultAgentId: null },
        { id: "ch2", defaultAgentId: null },
        { id: "ch3", defaultAgentId: "otro" },
        { id: "ch4", defaultAgentId: null, status: "inactive" },
      ],
    });

    const r = await assignPublishedAgentToChannels(prisma, "org1");

    expect(r.assigned).toBe(2);
    expect(channels.map((c) => c.defaultAgentId)).toEqual(["ag1", "ag1", "otro", null]);
  });

  it("…Safe no lanza si la BD falla (la conexión del canal nunca se cae por esto)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prisma: any = {
      admin: { organization: { findUnique: async () => ({ brand: "conversia" }) } },
      withTenant: async () => { throw new Error("db down"); },
    };

    const r = await assignPublishedAgentToChannelsSafe(prisma, "org1");

    expect(r).toMatchObject({ assigned: 0, reason: "error" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
