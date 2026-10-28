import { describe, expect, it } from "vitest";
import {
  classifyMetaSendError,
  MessageUndeliverableError,
  MetaRateLimitError,
} from "./channel-auth";
import { estadoDesdeMeta, estadosQuePermiten, permiteTransicion } from "./message-status-order";

/**
 * ETAPA 7 — WhatsApp y canales. Lo que se prueba acá son las dos REGLAS puras de la etapa:
 * cómo se clasifica un error de envío de Meta (§4.5) y cómo avanza el estado de un mensaje
 * cuando los webhooks llegan desordenados (§4.6).
 */

// ─────────────────────────────────────────────────────────────────────────────
// §4.5 — clasificación de errores de envío de Meta
// ─────────────────────────────────────────────────────────────────────────────
const metaError = (code: number, message = "x") => ({ error: { code, message } });

describe("§4.5 — ventana de 24 h y números que no reciben son TERMINALES", () => {
  it("131047 (ventana cerrada) → no entregable, con qué hacer", () => {
    const r = classifyMetaSendError(400, metaError(131047), "");
    expect(r).toBeInstanceOf(MessageUndeliverableError);
    // El mensaje que ve el dueño tiene que decirle la salida, no el código de Meta.
    expect((r as MessageUndeliverableError).userMessage).toMatch(/plantilla/i);
    expect((r as MessageUndeliverableError).userMessage).toMatch(/24 h/i);
  });

  it("131026 (no entregable) → no entregable, hablando del número", () => {
    const r = classifyMetaSendError(400, metaError(131026), "");
    expect(r).toBeInstanceOf(MessageUndeliverableError);
    expect((r as MessageUndeliverableError).userMessage).toMatch(/número/i);
  });

  it("también los reconoce desde el texto crudo (sin JSON parseable)", () => {
    const r = classifyMetaSendError(400, null, '{"error":{"code":131047,"message":"re-engagement"}}');
    expect(r).toBeInstanceOf(MessageUndeliverableError);
  });
});

describe("§4.5 — los rate limit esperan, no insisten", () => {
  it("130429 (cuenta) → espera larga", () => {
    const r = classifyMetaSendError(400, metaError(130429), "");
    expect(r).toBeInstanceOf(MetaRateLimitError);
    expect((r as MetaRateLimitError).retryAfterMs).toBe(15 * 60_000);
  });

  it("131056 (par número→destinatario) → espera corta: se suelta rápido", () => {
    const r = classifyMetaSendError(400, metaError(131056), "");
    expect(r).toBeInstanceOf(MetaRateLimitError);
    expect((r as MetaRateLimitError).retryAfterMs).toBe(60_000);
    expect((r as MetaRateLimitError).retryAfterMs).toBeLessThan(
      (classifyMetaSendError(400, metaError(130429), "") as MetaRateLimitError).retryAfterMs,
    );
  });

  it("un 429 sin código también se trata como limitación", () => {
    expect(classifyMetaSendError(429, null, "Too Many Requests")).toBeInstanceOf(MetaRateLimitError);
  });
});

describe("§4.5 — lo que NO clasifica sigue su camino de siempre", () => {
  it("un error cualquiera devuelve null (reintento genérico de BullMQ)", () => {
    expect(classifyMetaSendError(500, metaError(1), "")).toBeNull();
    expect(classifyMetaSendError(400, null, "algo raro")).toBeNull();
  });

  it("el 190 (token) NO lo toca: lo maneja ChannelAuthError", () => {
    expect(classifyMetaSendError(401, metaError(190), "")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4.6 — estados monótonos
// ─────────────────────────────────────────────────────────────────────────────
describe("§4.6 — el estado de un mensaje nunca va hacia atrás", () => {
  it("el progreso normal avanza", () => {
    expect(permiteTransicion("PENDING", "SENT")).toBe(true);
    expect(permiteTransicion("SENT", "DELIVERED")).toBe(true);
    expect(permiteTransicion("DELIVERED", "READ")).toBe(true);
    expect(permiteTransicion("PENDING", "READ")).toBe(true); // se puede saltar pasos
  });

  it("un status rezagado NO baja un mensaje ya leído", () => {
    expect(permiteTransicion("READ", "DELIVERED")).toBe(false);
    expect(permiteTransicion("READ", "SENT")).toBe(false);
    expect(permiteTransicion("DELIVERED", "SENT")).toBe(false);
  });

  it("FAILED es TERMINAL: nada lo pisa (ahí está el motivo del rebote)", () => {
    expect(permiteTransicion("FAILED", "SENT")).toBe(false);
    expect(permiteTransicion("FAILED", "DELIVERED")).toBe(false);
    expect(permiteTransicion("FAILED", "READ")).toBe(false);
    expect(permiteTransicion("FAILED", "FAILED")).toBe(false);
  });

  it("un rebote sí marca FAILED desde los estados no terminales…", () => {
    expect(permiteTransicion("PENDING", "FAILED")).toBe(true);
    expect(permiteTransicion("SENT", "FAILED")).toBe(true);
    expect(permiteTransicion("DELIVERED", "FAILED")).toBe(true);
  });

  it("…pero NO sobre uno ya LEÍDO (si se leyó, llegó)", () => {
    expect(permiteTransicion("READ", "FAILED")).toBe(false);
  });

  it("SUGGESTED (borrador del copiloto) queda fuera de este flujo", () => {
    expect(estadosQuePermiten("SUGGESTED")).toEqual([]);
    expect(permiteTransicion("SUGGESTED", "SENT")).toBe(false);
  });

  it("traduce los status de Meta", () => {
    expect(estadoDesdeMeta("read")).toBe("READ");
    expect(estadoDesdeMeta("delivered")).toBe("DELIVERED");
    expect(estadoDesdeMeta("failed")).toBe("FAILED");
    expect(estadoDesdeMeta("sent")).toBe("SENT");
    expect(estadoDesdeMeta("cualquier_cosa")).toBe("SENT");
  });

  it("el filtro que va al UPDATE nunca incluye el propio destino ni FAILED", () => {
    for (const destino of ["SENT", "DELIVERED", "READ", "FAILED"] as const) {
      const desde = estadosQuePermiten(destino);
      expect(desde, `${destino} no puede venir de sí mismo`).not.toContain(destino);
      expect(desde, `nada puede venir de FAILED`).not.toContain("FAILED");
    }
  });
});
