import { describe, expect, it } from "vitest";
import { phoneDigits, resolveOwnerContext, type OwnerCtxTx } from "./agent-turn";

/**
 * Auditoría etapa 2 (§2.1, §7.5) — MODO DUEÑO.
 *
 * Dos agujeros que cubren estos tests:
 *  a) La identidad salía de `contact.phone`, que una tool puede escribir: por
 *     Instagram/Messenger alguien se fijaba el teléfono del dueño y heredaba sus tools.
 *  b) Las consultas de roles/membresías no filtraban por organización: el teléfono del
 *     admin del cliente B abría el modo dueño en el cliente A.
 *
 * El `tx` falso EXIGE el filtro de organización: si el código no manda `organizationId`,
 * el mock no devuelve nada y el test falla. Así "org A no toca org B" se verifica de verdad.
 */

const ORG_A = "org-A";
const ORG_B = "org-B";

type Seen = { wheres: Array<Record<string, any>> };

function makeTx(
  data: {
    channels: Record<string, { organizationId: string; type: string }>;
    identities: Array<{ organizationId: string; contactId: string; channelType: string; externalId: string }>;
    roles: Array<{ organizationId: string; id: string; code: string }>;
    members: Array<{ organizationId: string; roleId: string; active: boolean; phone: string | null }>;
  },
  seen: Seen,
): OwnerCtxTx {
  return {
    channelConnection: {
      findFirst: async (args: any) => {
        seen.wheres.push(args.where);
        const c = data.channels[args.where.id];
        return c && c.organizationId === args.where.organizationId ? { type: c.type } : null;
      },
    },
    contactIdentity: {
      findFirst: async (args: any) => {
        seen.wheres.push(args.where);
        const i = data.identities.find(
          (x) =>
            x.organizationId === args.where.organizationId &&
            x.contactId === args.where.contactId &&
            x.channelType === args.where.channelType,
        );
        return i ? { externalId: i.externalId } : null;
      },
    },
    role: {
      findMany: async (args: any) => {
        seen.wheres.push(args.where);
        return data.roles
          .filter((r) => r.organizationId === args.where.organizationId && args.where.code.in.includes(r.code))
          .map((r) => ({ id: r.id }));
      },
    },
    organizationUser: {
      findMany: async (args: any) => {
        seen.wheres.push(args.where);
        return data.members
          .filter(
            (m) =>
              m.organizationId === args.where.organizationId &&
              m.active === args.where.active &&
              args.where.roleId.in.includes(m.roleId),
          )
          .map((m) => ({ user: { phone: m.phone } }));
      },
    },
  };
}

/** Dos clientes; en AMBOS el dueño usa el mismo teléfono (el caso que cruzaba datos). */
const DATA = {
  channels: {
    "wa-A": { organizationId: ORG_A, type: "WHATSAPP_CLOUD" },
    "ig-A": { organizationId: ORG_A, type: "INSTAGRAM" },
    "wa-B": { organizationId: ORG_B, type: "WHATSAPP_CLOUD" },
  },
  identities: [
    // El dueño de A escribiendo por WhatsApp de A.
    { organizationId: ORG_A, contactId: "c-dueñoA", channelType: "WHATSAPP_CLOUD", externalId: "56911111111" },
    // Un cliente final cualquiera de A.
    { organizationId: ORG_A, contactId: "c-cliente", channelType: "WHATSAPP_CLOUD", externalId: "56999999999" },
    // El MISMO número, pero como contacto del cliente B.
    { organizationId: ORG_B, contactId: "c-dueñoA", channelType: "WHATSAPP_CLOUD", externalId: "56911111111" },
  ],
  roles: [
    { organizationId: ORG_A, id: "r-ownerA", code: "owner" },
    { organizationId: ORG_B, id: "r-ownerB", code: "owner" },
  ],
  members: [
    // Dueño de A con el teléfono en formato "bonito" (+ y espacios): debe matchear igual.
    { organizationId: ORG_A, roleId: "r-ownerA", active: true, phone: "+56 9 1111 1111" },
    { organizationId: ORG_B, roleId: "r-ownerB", active: true, phone: "+56 9 2222 2222" },
  ],
};

describe("phoneDigits", () => {
  it("normaliza formatos para comparar", () => {
    expect(phoneDigits("+56 9 1111 1111")).toBe("56911111111");
    expect(phoneDigits("56911111111")).toBe("56911111111");
    expect(phoneDigits(null)).toBe("");
  });
});

describe("resolveOwnerContext — modo dueño aislado por cliente y por canal", () => {
  it("WhatsApp + número del dueño de ESTA org → true", async () => {
    const seen: Seen = { wheres: [] };
    const r = await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_A,
      contactId: "c-dueñoA",
      channelConnectionId: "wa-A",
    });
    expect(r).toBe(true);
  });

  it("un cliente final por WhatsApp NO es dueño", async () => {
    const seen: Seen = { wheres: [] };
    const r = await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_A,
      contactId: "c-cliente",
      channelConnectionId: "wa-A",
    });
    expect(r).toBe(false);
  });

  it("AISLAMIENTO: el teléfono del dueño de A no abre el modo dueño en B", async () => {
    const seen: Seen = { wheres: [] };
    const r = await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_B,
      contactId: "c-dueñoA", // mismo contacto/teléfono, pero operando en el cliente B
      channelConnectionId: "wa-B",
    });
    expect(r).toBe(false);
  });

  it("no se puede usar el canal de OTRA org (el canal de A no resuelve desde B)", async () => {
    const seen: Seen = { wheres: [] };
    const r = await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_B,
      contactId: "c-dueñoA",
      channelConnectionId: "wa-A",
    });
    expect(r).toBe(false);
  });

  it("§7.5: por Instagram NUNCA es dueño, aunque el teléfono coincida", async () => {
    const seen: Seen = { wheres: [] };
    const r = await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_A,
      contactId: "c-dueñoA",
      channelConnectionId: "ig-A",
    });
    expect(r).toBe(false);
  });

  it("sin canal (conversación sin channelConnectionId) → false", async () => {
    const seen: Seen = { wheres: [] };
    const r = await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_A,
      contactId: "c-dueñoA",
      channelConnectionId: null,
    });
    expect(r).toBe(false);
    expect(seen.wheres).toHaveLength(0); // ni siquiera consulta
  });

  it("TODAS las consultas llevan organizationId explícito", async () => {
    const seen: Seen = { wheres: [] };
    await resolveOwnerContext(makeTx(DATA, seen), {
      organizationId: ORG_A,
      contactId: "c-dueñoA",
      channelConnectionId: "wa-A",
    });
    expect(seen.wheres.length).toBeGreaterThanOrEqual(4);
    for (const w of seen.wheres) expect(w.organizationId).toBe(ORG_A);
  });
});
