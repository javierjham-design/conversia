import { describe, expect, it, vi } from "vitest";

/**
 * Auditoría etapa 2, punto 5 (§2.0 fila 4) — el fallback "cualquier número activo".
 *
 * El agujero: si una organización no tenía número propio, `resolveChannelAuth` caía a
 * `whatsappPhoneNumber.findFirst({ status: "active" })` SIN filtrar organización → el
 * mensaje podía salir por el WhatsApp de OTRO cliente (con su token y su número).
 *
 * Ahora: el número siempre se busca dentro de la organización y, si no hay ninguno
 * propio, se FALLA con un motivo claro (nunca se usa el de otro).
 */

vi.hoisted(() => {
  process.env.WHATSAPP_PROVIDER = "meta"; // con el proveedor real; en mock se conserva el id sintético
  process.env.META_ACCESS_TOKEN = "token-global";
});

const captured: Array<{ op: string; where: Record<string, any> }> = [];

vi.mock("@conversia/database", () => {
  // Cliente A tiene número propio; cliente B NO tiene ninguno.
  const NUMBERS = [
    {
      id: "n-A",
      organizationId: "org-A",
      phoneNumberId: "PN-A",
      channelConnectionId: "ch-A",
      status: "active",
      accountId: "acc-A",
    },
  ];
  const ACCOUNTS = [{ id: "acc-A", organizationId: "org-A", credentialId: null }];
  const CHANNELS = [{ id: "ch-A", organizationId: "org-A", type: "WHATSAPP_CLOUD" }];
  const ORGS = [
    { id: "org-A", slug: "cliente-a" },
    { id: "org-B", slug: "cliente-b" },
  ];

  const tx = {
    whatsappPhoneNumber: {
      findFirst: async (args: any) => {
        captured.push({ op: "whatsappPhoneNumber.findFirst", where: args.where });
        const w = args.where;
        return (
          NUMBERS.find(
            (n) =>
              n.organizationId === w.organizationId &&
              (w.phoneNumberId === undefined || n.phoneNumberId === w.phoneNumberId) &&
              (w.channelConnectionId === undefined || n.channelConnectionId === w.channelConnectionId) &&
              (w.status === undefined || n.status === w.status),
          ) ?? null
        );
      },
    },
    channelConnection: {
      findFirst: async (args: any) => {
        captured.push({ op: "channelConnection.findFirst", where: args.where });
        return CHANNELS.find((c) => c.id === args.where.id && c.organizationId === args.where.organizationId) ?? null;
      },
    },
    whatsappAccount: {
      findFirst: async (args: any) => {
        captured.push({ op: "whatsappAccount.findFirst", where: args.where });
        return ACCOUNTS.find((a) => a.id === args.where.id && a.organizationId === args.where.organizationId) ?? null;
      },
    },
    integrationCredential: { findFirst: async () => null },
    organization: { findUnique: async (args: any) => ORGS.find((o) => o.id === args.where.id) ?? null },
  };

  return {
    withTenant: async (_orgId: string, fn: any) => fn(tx),
    getAdminPrisma: () => ({}),
    raiseException: async () => undefined,
    resolveException: async () => undefined,
  };
});

import { ChannelConfigError, resolveChannelAuth } from "./channel-auth";

describe("resolveChannelAuth — nunca envía por el número de otro cliente", () => {
  it("el cliente A resuelve SU propio número", async () => {
    captured.length = 0;
    const auth = await resolveChannelAuth("org-A", { channelConnectionId: "ch-A" });
    expect(auth.phoneNumberId).toBe("PN-A");
    for (const c of captured) expect(c.where.organizationId).toBe("org-A");
  });

  it("AISLAMIENTO: el cliente B sin número propio FALLA, no hereda el de A", async () => {
    captured.length = 0;
    await expect(resolveChannelAuth("org-B", {})).rejects.toBeInstanceOf(ChannelConfigError);
    // Jamás se consultó un número fuera de org-B…
    for (const c of captured) expect(c.where.organizationId).toBe("org-B");
    // …y el fallback "primer número activo" ahora va acotado a la organización.
    const fallback = captured.find(
      (c) => c.op === "whatsappPhoneNumber.findFirst" && c.where.status === "active",
    );
    expect(fallback?.where.organizationId).toBe("org-B");
  });

  it("el error trae un motivo accionable para la Bandeja", async () => {
    await expect(resolveChannelAuth("org-B", {})).rejects.toMatchObject({
      kind: "channel_config",
      userMessage: expect.stringContaining("no tiene un canal de WhatsApp activo propio"),
    });
  });

  it("el cliente B tampoco puede usar el canal de A", async () => {
    captured.length = 0;
    await expect(resolveChannelAuth("org-B", { channelConnectionId: "ch-A" })).rejects.toBeInstanceOf(
      ChannelConfigError,
    );
    for (const c of captured) expect(c.where.organizationId).toBe("org-B");
  });
});
