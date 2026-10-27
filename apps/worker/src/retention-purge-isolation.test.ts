import { describe, expect, it, vi } from "vitest";

/**
 * Auditoría etapa 2, punto 3 (§2.0 fila 1) — la purga por retención es la operación MÁS
 * peligrosa del sistema: borra conversaciones. Si el `deleteMany` no lleva el filtro de
 * organización y la RLS no está activa (o el rol tiene BYPASSRLS), la purga de un cliente
 * se lleva por delante los datos de otro.
 *
 * Este test corre la purga con DOS organizaciones y exige que cada consulta destructiva
 * lleve el `organizationId` de la org que se está purgando.
 */

const captured: Array<{ op: string; where: Record<string, any> }> = [];

vi.mock("@conversia/database", () => {
  const makeTx = (orgId: string) => ({
    conversation: {
      findMany: async (args: any) => {
        captured.push({ op: "conversation.findMany", where: args.where });
        return [{ id: `conv-${orgId}` }];
      },
      deleteMany: async (args: any) => {
        captured.push({ op: "conversation.deleteMany", where: args.where });
        return { count: 1 };
      },
    },
    message: {
      updateMany: async (args: any) => {
        captured.push({ op: "message.updateMany", where: args.where });
        return { count: 1 };
      },
    },
    auditLog: { create: async () => ({}) },
    organization: { update: async () => ({}) },
  });
  return {
    getAdminPrisma: () => ({
      organization: {
        findMany: async () => [
          { id: "org-A", settings: { retention: { conversationsMonths: 6, transcriptionsMonths: 6 } } },
          { id: "org-B", settings: { retention: { conversationsMonths: 6, transcriptionsMonths: 6 } } },
        ],
      },
    }),
    withTenant: async (orgId: string, fn: any) => fn(makeTx(orgId)),
  };
});

import { retentionCutoff, startRetentionPurge } from "./retention-purge";

describe("retentionCutoff", () => {
  it("0 meses = indefinido (no purga)", () => {
    expect(retentionCutoff(0)).toBeNull();
    expect(retentionCutoff(-3)).toBeNull();
  });
  it("devuelve una fecha pasada para meses > 0", () => {
    const d = retentionCutoff(6, new Date("2026-10-27T00:00:00Z"));
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBeLessThan(Date.parse("2026-10-27T00:00:00Z"));
  });
});

describe("purga por retención — aislamiento entre clientes", () => {
  it("TODA consulta destructiva lleva el organizationId de la org que se purga", async () => {
    captured.length = 0;
    const stop = startRetentionPurge();
    await new Promise((r) => setTimeout(r, 20)); // dejar completar el tick inicial
    stop();

    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.where.organizationId, `${c.op} sin organizationId`).toBeTruthy();
    }
    // Las dos orgs se purgaron, y cada una solo lo suyo.
    expect(new Set(captured.map((c) => c.where.organizationId))).toEqual(new Set(["org-A", "org-B"]));
    // El borrado de conversaciones (lo irreversible) está acotado sí o sí.
    const deletes = captured.filter((c) => c.op === "conversation.deleteMany");
    expect(deletes.length).toBe(2);
    for (const d of deletes) expect(d.where.organizationId).toMatch(/^org-[AB]$/);
  });
});
