import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

// El env se fija ANTES de que @conversia/config cachee getEnv (vi.hoisted corre
// previo a los imports): el montaje asistido exige un ORG de proveedor configurado.
vi.hoisted(() => {
  process.env.ASSISTED_SETUP_PROVIDER_ORG_ID = "org-proveedor";
});

import { AssistedSetupController } from "../src/assisted-setup/assisted-setup.controller";
import { runWithContext, type RequestContext } from "../src/tenancy/context";

/**
 * Auditoría etapa 2, punto 2 (§1.2) — montaje asistido con filtro EXPLÍCITO de organización.
 * El `tx` falso exige el filtro: si la consulta no manda `organizationId`, no encuentra nada.
 */

const ORG_A = "org-A";
const ORG_B = "org-B";

type Seen = { calls: Array<{ op: string; where: Record<string, any> }> };

function makePrisma(seen: Seen, channels: Array<{ id: string; organizationId: string; name: string }>) {
  const tx = {
    channelConnection: {
      findFirst: async ({ where }: any) => {
        seen.calls.push({ op: "channelConnection.findFirst", where });
        return channels.find((c) => c.id === where.id && c.organizationId === where.organizationId) ?? null;
      },
    },
    assistedSetupGrant: {
      updateMany: async ({ where }: any) => {
        seen.calls.push({ op: "assistedSetupGrant.updateMany", where });
        return { count: 0 };
      },
      create: async ({ data }: any) => ({ id: "g1", ...data }),
    },
    auditLog: { create: async () => ({}) },
  };
  return { withTenant: (_org: string, fn: any) => fn(tx), admin: {} } as any;
}

const ctx = (orgId: string): RequestContext => ({
  userId: "u1",
  organizationId: orgId,
  roleCode: "owner",
  permissions: ["settings:write"],
});

describe("AssistedSetupController.authorize — aislamiento entre clientes", () => {
  it("la revocación de permisos previos se acota a SU organización", async () => {
    const seen: Seen = { calls: [] };
    const c = new AssistedSetupController(makePrisma(seen, []));
    await runWithContext(ctx(ORG_A), () => c.authorize({}));
    const revoke = seen.calls.find((x) => x.op === "assistedSetupGrant.updateMany");
    expect(revoke?.where.organizationId).toBe(ORG_A);
  });

  it("NO acepta un canal de otra organización", async () => {
    const seen: Seen = { calls: [] };
    const channels = [{ id: "ch-B", organizationId: ORG_B, name: "Canal del cliente B" }];
    const c = new AssistedSetupController(makePrisma(seen, channels));
    await expect(
      runWithContext(ctx(ORG_A), () => c.authorize({ channelId: "ch-B" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    const look = seen.calls.find((x) => x.op === "channelConnection.findFirst");
    expect(look?.where.organizationId).toBe(ORG_A);
  });

  it("sí acepta un canal propio", async () => {
    const seen: Seen = { calls: [] };
    const channels = [{ id: "ch-A", organizationId: ORG_A, name: "Canal del cliente A" }];
    const c = new AssistedSetupController(makePrisma(seen, channels));
    const res: any = await runWithContext(ctx(ORG_A), () => c.authorize({ channelId: "ch-A" }));
    expect(res.ok).toBe(true);
    expect(res.authorized).toBe(true);
  });
});
