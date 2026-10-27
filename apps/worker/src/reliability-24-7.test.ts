import { describe, expect, it, vi } from "vitest";

/**
 * ETAPA 3 — Confiabilidad del bot 24/7. Cubre los cuatro casos que pide la auditoría:
 * cerrojo por conversación (§8.1), rescate del turno en el camino duplicado (§8.3),
 * no reenviar un mensaje ya despachado (§4.5/§8.4) y el corte del día del tope de
 * tokens en la zona horaria de la organización (§8.6).
 */

// Redis falso en memoria: alcanza para SET NX/PX/EX, GET, DEL y el script de liberación.
vi.mock("ioredis", () => {
  class FakeRedis {
    store = new Map<string, string>();
    async set(key: string, value: string, ...args: unknown[]) {
      const flags = args.map((a) => String(a).toUpperCase());
      if (flags.includes("NX") && this.store.has(key)) return null;
      this.store.set(key, value);
      return "OK";
    }
    async get(key: string) {
      return this.store.get(key) ?? null;
    }
    async del(key: string) {
      return this.store.delete(key) ? 1 : 0;
    }
    // El único eval que usamos es "borrar si el valor coincide".
    async eval(_script: string, _n: number, key: string, arg: string) {
      if (this.store.get(key) === arg) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
  }
  return { default: FakeRedis };
});

import { acquireConversationLock, newLockToken, releaseConversationLock } from "./conversation-lock";
import { claimSend, markSent, releaseSend } from "./send-claim";
import { startOfDayInTimezone } from "./agent-turn";
import { conversationAwaitingReply } from "./inbound";

describe("§8.1 cerrojo por conversación", () => {
  it("dos turnos concurrentes: el segundo NO obtiene el cerrojo (se reencola)", async () => {
    const primero = newLockToken();
    const segundo = newLockToken();
    expect(await acquireConversationLock("conv-1", primero)).toBe(true);
    expect(await acquireConversationLock("conv-1", segundo)).toBe(false);
  });

  it("solo lo libera quien lo tomó (un turno vencido no suelta el cerrojo del siguiente)", async () => {
    const mio = newLockToken();
    const ajeno = newLockToken();
    expect(await acquireConversationLock("conv-2", mio)).toBe(true);

    await releaseConversationLock("conv-2", ajeno); // token ajeno: NO debe liberar
    expect(await acquireConversationLock("conv-2", ajeno)).toBe(false);

    await releaseConversationLock("conv-2", mio); // el dueño sí libera
    expect(await acquireConversationLock("conv-2", ajeno)).toBe(true);
  });

  it("conversaciones distintas no se bloquean entre sí", async () => {
    expect(await acquireConversationLock("conv-A", newLockToken())).toBe(true);
    expect(await acquireConversationLock("conv-B", newLockToken())).toBe(true);
  });
});

describe("§4.5/§8.4 doble envío al reintentar", () => {
  it("si YA se despachó, el reintento no reenvía: solo reconcilia el estado", async () => {
    expect((await claimSend("msg-1")).ok).toBe(true);
    await markSent("msg-1", "wamid.111");

    const reintento = await claimSend("msg-1");
    expect(reintento).toEqual({ ok: false, alreadySent: true, externalId: "wamid.111" });
  });

  it("otro intento en vuelo: no se despacha en paralelo", async () => {
    expect((await claimSend("msg-2")).ok).toBe(true);
    expect(await claimSend("msg-2")).toEqual({ ok: false, alreadySent: false });
  });

  it("si el despacho NO llegó a salir, se libera y el reintento sí puede enviar", async () => {
    expect((await claimSend("msg-3")).ok).toBe(true);
    await releaseSend("msg-3"); // el envío falló antes de llegar a Meta
    expect((await claimSend("msg-3")).ok).toBe(true);
  });
});

describe("§8.3 camino duplicado: rescatar el turno solo si nadie respondió", () => {
  const entrante = new Date("2026-01-01T10:00:00Z");
  const txSinRespuesta = {
    message: {
      findFirst: async (args: any) =>
        args.where.direction === "INBOUND" ? { createdAt: entrante } : null,
    },
  };
  const txConRespuesta = {
    message: {
      findFirst: async (args: any) =>
        args.where.direction === "INBOUND"
          ? { createdAt: entrante }
          : { createdAt: new Date("2026-01-01T10:00:05Z") },
    },
  };

  it("sin respuesta posterior → hay que reencolar el turno (si no, bot mudo)", async () => {
    expect(await conversationAwaitingReply(txSinRespuesta, "org-1", "conv-1")).toBe(true);
  });

  it("ya respondida → NO se reencola (evita la respuesta duplicada)", async () => {
    expect(await conversationAwaitingReply(txConRespuesta, "org-1", "conv-1")).toBe(false);
  });

  it("conversación sin mensajes entrantes → no se reencola nada", async () => {
    const vacio = { message: { findFirst: async () => null } };
    expect(await conversationAwaitingReply(vacio, "org-1", "conv-1")).toBe(false);
  });
});

describe("§8.6 el día del tope de tokens se corta en la zona de la organización", () => {
  it("un tenant chileno no ve reiniciarse el tope a las 21:00 (hora del servidor UTC)", () => {
    // 2026-10-27 01:00 UTC = 2026-10-26 22:00 en Santiago → en Chile todavía es el día 26.
    const ahora = new Date("2026-10-27T01:00:00Z");
    const santiago = startOfDayInTimezone("America/Santiago", ahora);
    const utc = startOfDayInTimezone("UTC", ahora);

    expect(utc.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    // El corte chileno es ANTERIOR: el día chileno empezó antes de la medianoche UTC.
    expect(santiago.getTime()).toBeLessThan(utc.getTime());
    expect(santiago.toISOString().slice(0, 10)).toBe("2026-10-26");
  });

  it("zona horaria inválida → cae al comportamiento anterior sin romper", () => {
    const d = startOfDayInTimezone("No/Existe", new Date("2026-10-27T01:00:00Z"));
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});
