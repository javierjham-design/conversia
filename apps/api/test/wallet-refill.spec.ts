import { describe, expect, it } from "vitest";
import { messageWalletQuota, refillMessageWallet } from "@conversia/database";

/**
 * §9.3/§9.5 — recarga de la bolsa de mensajes.
 *
 * Lo que protege este test (decisión del dueño, 27-oct): una acción MANUAL del super admin
 * —asignar una suscripción o registrar un pago— **no puede borrarle al cliente los packs
 * que compró y todavía no usó**.
 *
 * Con un cupo de 1.000 y un cliente que tiene 5.000 créditos comprados:
 *   - renovación por pasarela (`cap`):  min(5.000, 1.000) + 1.000 = 2.000  → pierde 3.000
 *   - acción manual     (`keep`):       5.000 + 1.000          = 6.000  → no pierde nada
 *
 * El cálculo lo hace Postgres, así que acá verificamos la SENTENCIA que se emite (que es
 * donde vive la fórmula) y el asiento del libro.
 */

function fakeDb(balanceBefore: number, balanceAfter: number) {
  const sql: string[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const db = {
    messageWallet: { findUnique: async () => ({ balance: balanceBefore }) },
    $queryRaw: async (strings: TemplateStringsArray) => {
      sql.push(strings.join("?"));
      return [{ balance: balanceAfter }];
    },
    walletLedger: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        ledger.push(data);
        return data;
      },
    },
  } as never;
  return { db, sql, ledger };
}

describe("refillMessageWallet — carryover", () => {
  it('acción MANUAL del super admin ("keep"): SUMA el cupo, no recorta el saldo comprado', async () => {
    const { db, sql, ledger } = fakeDb(5000, 6000);
    const r = await refillMessageWallet(db, { organizationId: "org-1", included: 1000, carryover: "keep" });

    const update = sql.join("\n");
    expect(update).toContain('"balance" = "message_wallets"."balance" + ');
    expect(update).not.toContain("LEAST"); // no se recorta
    expect(r.balanceAfter).toBe(6000);
    expect(ledger[0]?.delta).toBe(1000); // sumó el cupo; no borró los 5.000 comprados
  });

  it('renovación por pasarela (default "cap"): mantiene el tope de carryover', async () => {
    const { db, sql } = fakeDb(5000, 2000);
    await refillMessageWallet(db, { organizationId: "org-1", included: 1000 });

    const update = sql.join("\n");
    expect(update).toContain("LEAST");
    expect(update).toContain('"balance" = LEAST("message_wallets"."balance", ');
  });

  it("una sola sentencia atómica (no leer-modificar-escribir)", async () => {
    const { db, sql } = fakeDb(0, 1000);
    await refillMessageWallet(db, { organizationId: "org-1", included: 1000, carryover: "keep" });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("ON CONFLICT");
  });

  it("el asiento del libro registra el saldo resultante", async () => {
    const { db, ledger } = fakeDb(120, 1120);
    await refillMessageWallet(db, { organizationId: "org-1", included: 1000, carryover: "keep", refId: "inv-9" });
    expect(ledger[0]).toMatchObject({
      organizationId: "org-1",
      reason: "plan_renewal",
      balanceAfter: 1120,
      delta: 1000,
      refId: "inv-9",
    });
  });

  it("exige organizationId", async () => {
    const { db } = fakeDb(0, 0);
    await expect(refillMessageWallet(db, { organizationId: "", included: 10 })).rejects.toThrow(/organizationId/i);
  });
});

describe("messageWalletQuota", () => {
  it("-1 = ilimitado (práctico)", () => {
    expect(messageWalletQuota({ templateMessages: -1 }, 500)).toBe(1_000_000);
  });
  it("0 = plan sin cupo (Free)", () => {
    expect(messageWalletQuota({ templateMessages: 0 }, 500)).toBe(0);
  });
  it("sin definir = default de la plataforma", () => {
    expect(messageWalletQuota({}, 500)).toBe(500);
    expect(messageWalletQuota(null, 500)).toBe(500);
  });
});
