import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { CashController } from "../src/charging/cash.controller";
import { runWithContext, type RequestContext } from "../src/tenancy/context";

// F9 regla 8 — tests que la spec exige por nombre: idempotencia (doble-click) y permisos.
// (El aislamiento RLS de cash_ledger/cash_closures lo valida verify-isolation en CI, que
// barre TODA tabla con organization_id con el rol real conversia_app sin BYPASSRLS.)

function makePrisma() {
  const ledger: any[] = [];
  const audit: any[] = [];
  const tx = {
    cashLedger: {
      findUnique: async ({ where }: any) => {
        const k = where.organizationId_idempotencyKey;
        return ledger.find((e) => e.organizationId === k.organizationId && e.idempotencyKey === k.idempotencyKey) ?? null;
      },
      findFirst: async ({ where }: any) => ledger.find((e) => e.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const e = { id: `e${ledger.length + 1}`, ...data };
        ledger.push(e);
        return e;
      },
    },
    auditLog: { create: async ({ data }: any) => { audit.push(data); return data; } },
  };
  const prisma: any = { withTenant: (_org: string, fn: any) => fn(tx), admin: {} };
  return { prisma, ledger, audit };
}

const ctx = (permissions: string[]): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "x", permissions });

describe("F9 CashController — permisos + idempotencia", () => {
  it("createEntry sin cash:manage → 403 (cash:report es solo lectura)", async () => {
    const { prisma } = makePrisma();
    const c = new CashController(prisma);
    await expect(
      runWithContext(ctx(["cash:report"]), () => c.createEntry({ type: "ingreso", method: "efectivo", amount: 1000 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("createEntry idempotente: misma clave no duplica el asiento", async () => {
    const { prisma, ledger } = makePrisma();
    const c = new CashController(prisma);
    const body = { type: "ingreso", method: "efectivo", amount: 1000, idempotencyKey: "k1" };
    const r1: any = await runWithContext(ctx(["cash:manage"]), () => c.createEntry(body));
    const r2: any = await runWithContext(ctx(["cash:manage"]), () => c.createEntry(body));
    expect(ledger.length).toBe(1);
    expect(r2.idempotent).toBe(true);
    expect(r2.id).toBe(r1.id);
  });

  it("egreso guarda monto NEGATIVO (signo correcto)", async () => {
    const { prisma, ledger } = makePrisma();
    const c = new CashController(prisma);
    await runWithContext(ctx(["cash:manage"]), () => c.createEntry({ type: "egreso", method: "efectivo", amount: 5000, idempotencyKey: "k2" }));
    expect(ledger[0].amount).toBe(-5000);
  });

  it("reverse crea el asiento opuesto y es idempotente por reversa:<id>", async () => {
    const { prisma, ledger } = makePrisma();
    const c = new CashController(prisma);
    const r1: any = await runWithContext(ctx(["cash:manage"]), () => c.createEntry({ type: "ingreso", method: "efectivo", amount: 4000, idempotencyKey: "k3" }));
    await runWithContext(ctx(["cash:manage"]), () => c.reverse({ entryId: r1.id }));
    await runWithContext(ctx(["cash:manage"]), () => c.reverse({ entryId: r1.id })); // 2ª vez: no debe duplicar
    const reversas = ledger.filter((e) => e.type === "reversa");
    expect(reversas.length).toBe(1);
    expect(reversas[0].amount).toBe(-4000);
  });

  it("reverse sin cash:manage → 403", async () => {
    const { prisma } = makePrisma();
    const c = new CashController(prisma);
    await expect(
      runWithContext(ctx(["cash:report"]), () => c.reverse({ entryId: "x" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
