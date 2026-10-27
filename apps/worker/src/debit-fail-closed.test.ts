import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * §9.5 — El débito de bolsa debe fallar CERRADO.
 *
 * Antes, el débito compartía el `try/catch` fail-open de los topes: si la BD fallaba, el
 * catch se tragaba el error y `chargeTemplateSend` devolvía "no bloqueado" → la plantilla
 * salía SIN cobrarse. Es decir, mensajes gratis a costa de la plataforma y sin rastro.
 *
 * Acá la BD está caída a propósito: los topes deben seguir fallando ABIERTO (no pueden
 * cortarle los envíos a todos por un problema de infraestructura) pero el DÉBITO tiene que
 * bloquear y alertar.
 */

let debitBehavior: () => Promise<unknown> = async () => {
  throw new Error("BD caída");
};
const alertas: string[] = [];

// Toda la infraestructura cae: así los chequeos de topes/negocio entran por su catch
// fail-open y llegamos limpio al débito, que es lo que queremos probar.
vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => {
    throw new Error("BD caída");
  },
  withTenant: async () => {
    throw new Error("BD caída");
  },
  raiseException: async () => undefined,
}));
vi.mock("ioredis", () => ({
  default: class {
    async get() {
      return null;
    }
    async set() {
      return "OK";
    }
    async incr() {
      return 1;
    }
    async expire() {
      return 1;
    }
    async ttl() {
      return -1;
    }
  },
}));
vi.mock("./wallet", () => ({
  debitForMessage: async () => debitBehavior(),
  notifyWalletThresholds: async () => undefined,
  refundForMessage: async () => undefined,
}));
vi.mock("./conversation-quota", () => ({ countConversationOnce: async () => undefined }));
vi.mock("./service-metering", () => ({
  isWithinServiceFreeTier: async () => false,
  resolveServiceWindowTz: async () => "UTC",
}));
vi.mock("./notifications/queue", () => ({ enqueueNotification: async () => undefined }));
vi.mock("./conversation-credits", () => ({
  planDebitsConversation: async () => false,
  conversationCreditMultiplier: async () => 1,
  debitConversation: async () => ({ ok: true }),
  creditsNotifyDecision: () => null,
}));
vi.mock("./ops-alert.js", () => ({
  opsAlert: async (i: { summary: string }) => {
    alertas.push(i.summary);
  },
}));

import { chargeTemplateSend } from "./messaging-guard";

describe("§9.5 débito de bolsa fail-closed", () => {
  beforeEach(() => {
    alertas.length = 0;
  });

  it("con la BD caída NO deja pasar la plantilla gratis: bloquea y alerta", async () => {
    debitBehavior = async () => {
      throw new Error("BD caída");
    };
    const gate = await chargeTemplateSend("org-1", "msg-1", "marketing");
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toBe("debit_unavailable");
    expect(alertas.some((s) => /Débito de bolsa caído/i.test(s))).toBe(true);
  });

  it("sin saldo sigue bloqueando por saldo (no se confunde con el fallo de infraestructura)", async () => {
    debitBehavior = async () => ({ ok: false, reason: "no_balance", balance: 0 });
    const gate = await chargeTemplateSend("org-1", "msg-2", "marketing");
    expect(gate.blocked).toBe(true);
    expect(gate.reason).toBe("no_balance");
  });

  it("camino feliz: si el débito funciona, el envío NO se bloquea", async () => {
    debitBehavior = async () => ({ ok: true, balance: 42 });
    const gate = await chargeTemplateSend("org-1", "msg-3", "marketing");
    expect(gate.blocked).toBe(false);
  });
});
