import { describe, expect, it } from "vitest";
import { classifyBlockingSendError, observeSendFailure, observeSendSuccess, type SendHealthDeps } from "./sending-health.js";

// Redis en memoria con la semántica que usa el módulo: SET ... NX (no pisa si existe) y DEL.
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(k: string, v: string, ...args: unknown[]) {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
    async get(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    async del(k: string) {
      const had = store.has(k);
      store.delete(k);
      return had ? 1 : 0;
    },
  };
}

// Espías que cuentan llamadas y guardan los argumentos.
function spies() {
  const record: any[] = [];
  const notify: any[] = [];
  const ops: any[] = [];
  const deps: SendHealthDeps = {
    enabled: true,
    record: async (org, status, type, message, payload) => void record.push({ org, status, type, message, payload }),
    notifyOwner: async (org, subject, html) => void notify.push({ org, subject, html }),
    ops: async (input) => void ops.push(input),
  };
  return { record, notify, ops, deps };
}

const ORG = "org_test";
const ERR_PAGO = "Meta #131042: Message failed to send because your WhatsApp Business account has unsettled payments.";

describe("classifyBlockingSendError", () => {
  it("detecta el bloqueo de pago por código y por texto", () => {
    expect(classifyBlockingSendError(ERR_PAGO)?.code).toBe("131042");
    expect(classifyBlockingSendError("errors related to your payment method")?.code).toBe("131042");
    expect(classifyBlockingSendError('{"error":{"code":131042}}')?.code).toBe("131042");
  });
  it("detecta la cuenta restringida (#131031)", () => {
    expect(classifyBlockingSendError("Meta #131031: account restricted")?.code).toBe("131031");
  });
  it("NO alerta por errores de destinatario ni rate limit ni vacío", () => {
    expect(classifyBlockingSendError("Meta #131026: Message Undeliverable.")).toBeNull();
    expect(classifyBlockingSendError("Meta #131047: re-engagement message")).toBeNull();
    expect(classifyBlockingSendError("Meta #130429: rate limit hit")).toBeNull();
    expect(classifyBlockingSendError("")).toBeNull();
    expect(classifyBlockingSendError(null)).toBeNull();
  });
});

describe("observeSendFailure", () => {
  it("alerta UNA sola vez por incidente (correo + ops + evento), aunque reboten varias plantillas", async () => {
    const { record, notify, ops, deps } = spies();
    const redis = fakeRedis();
    const d = { ...deps, redis: redis as any };

    await observeSendFailure(ORG, ERR_PAGO, d);
    expect(record).toHaveLength(1);
    expect(record[0].type).toBe("whatsapp.sending_blocked");
    expect(record[0].status).toBe("error");
    expect(notify).toHaveLength(1);
    expect(notify[0].org).toBe(ORG);
    expect(notify[0].subject).toMatch(/no está enviando/i);
    expect(ops).toHaveLength(1);
    expect(ops[0].severity).toBe("critical");

    // Segundo (y tercer) rebote del MISMO incidente: NO vuelve a alertar.
    await observeSendFailure(ORG, ERR_PAGO, d);
    await observeSendFailure(ORG, "Meta #131042: unsettled payments", d);
    expect(record).toHaveLength(1);
    expect(notify).toHaveLength(1);
    expect(ops).toHaveLength(1);
  });

  it("no hace nada ante ruido por-destinatario", async () => {
    const { record, notify, ops, deps } = spies();
    await observeSendFailure(ORG, "Meta #131026: Message Undeliverable.", { ...deps, redis: fakeRedis() as any });
    expect(record).toHaveLength(0);
    expect(notify).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });

  it("deshabilitado (no producción) no alerta aunque sea bloqueante", async () => {
    const { record, notify, ops, deps } = spies();
    await observeSendFailure(ORG, ERR_PAGO, { ...deps, enabled: false, redis: fakeRedis() as any });
    expect(record.length + notify.length + ops.length).toBe(0);
  });
});

describe("observeSendSuccess", () => {
  it("sin incidente abierto no hace nada", async () => {
    const { record, notify, ops, deps } = spies();
    await observeSendSuccess(ORG, { ...deps, redis: fakeRedis() as any });
    expect(record.length + notify.length + ops.length).toBe(0);
  });

  it("cierra el incidente y avisa la recuperación UNA sola vez", async () => {
    const { record, notify, ops, deps } = spies();
    const redis = fakeRedis();
    const d = { ...deps, redis: redis as any };

    await observeSendFailure(ORG, ERR_PAGO, d); // abre incidente
    await observeSendSuccess(ORG, d); // se vuelve a entregar
    const recov = record.find((r) => r.type === "whatsapp.sending_recovered");
    expect(recov).toBeTruthy();
    expect(recov.status).toBe("ok");
    expect(notify.some((n) => /volvió a enviar/i.test(n.subject))).toBe(true);
    expect(ops.some((o) => o.severity === "info")).toBe(true);

    const recovCount = record.filter((r) => r.type === "whatsapp.sending_recovered").length;
    await observeSendSuccess(ORG, d); // segunda entrega: nada nuevo
    expect(record.filter((r) => r.type === "whatsapp.sending_recovered")).toHaveLength(recovCount);
  });
});
