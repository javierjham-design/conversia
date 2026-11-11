import { describe, it, expect } from "vitest";
import { evaluarVigencia, servicioVigente, frasePorVigenciaVencida } from "./vigencia";

const AHORA = new Date("2026-11-11T20:00:00.000Z");
const iso = (s: string) => new Date(s).toISOString();

describe("vigencia del servicio — una suscripción viva manda sobre un validUntil viejo", () => {
  it("EL CASO REAL: digital-dent-temuco, vigencia del 2-nov y suscripción ACTIVE hasta el 11-dic", () => {
    const e = evaluarVigencia({
      validUntil: "2026-11-02T23:57:37.944Z",
      suscripcion: { status: "ACTIVE", periodEnd: new Date("2026-12-11T20:51:56.557Z") },
      ahora: AHORA,
    });
    expect(e.vigente).toBe(true);
    expect(e.motivo).toBe("cubierto_por_suscripcion");
    expect(e.cubiertoHasta).toBe(iso("2026-12-11T20:51:56.557Z"));
  });

  it("TRIALING también cubre (las tres cuentas de prueba que estaban bloqueadas)", () => {
    const e = evaluarVigencia({
      validUntil: "2026-10-22T18:12:43.137Z",
      suscripcion: { status: "TRIALING", periodEnd: "2026-12-14T18:12:43.126Z" },
      ahora: AHORA,
    });
    expect(e.vigente).toBe(true);
    expect(e.motivo).toBe("cubierto_por_suscripcion");
  });

  it("sin fecha de corte no hay nada que vencer", () => {
    expect(evaluarVigencia({ validUntil: null, ahora: AHORA }).motivo).toBe("sin_vencimiento");
    expect(evaluarVigencia({ validUntil: undefined, ahora: AHORA }).vigente).toBe(true);
  });

  it("la fecha de corte futura basta sola, sin mirar la suscripción", () => {
    const e = evaluarVigencia({ validUntil: "2027-01-01T00:00:00.000Z", suscripcion: null, ahora: AHORA });
    expect(e.motivo).toBe("al_dia");
    expect(e.cubiertoHasta).toBeNull();
  });
});

describe("lo que SÍ se sigue bloqueando (si esto se rompe, se regala el servicio)", () => {
  it("vencida y sin suscripción → NO vigente", () => {
    const e = evaluarVigencia({ validUntil: "2026-09-02T00:00:00.000Z", suscripcion: null, ahora: AHORA });
    expect(e.vigente).toBe(false);
    expect(e.motivo).toBe("vencida");
  });

  it("vencida y con la suscripción TAMBIÉN vencida → NO vigente (el caso de aura-neutra)", () => {
    const e = evaluarVigencia({
      validUntil: "2026-09-02T00:00:00.000Z",
      suscripcion: { status: "ACTIVE", periodEnd: "2026-09-26T03:34:18.000Z" },
      ahora: AHORA,
    });
    expect(e.vigente).toBe(false);
  });

  it("un estado de suscripción que NO acredita servicio no cubre nada", () => {
    for (const status of ["PAST_DUE", "CANCELLED", "PAUSED", "INCOMPLETE", "", null, undefined]) {
      const e = evaluarVigencia({
        validUntil: "2026-10-01T00:00:00.000Z",
        suscripcion: { status: status as string | null, periodEnd: "2027-01-01T00:00:00.000Z" },
        ahora: AHORA,
      });
      expect(e.vigente, `status=${String(status)} no debe cubrir`).toBe(false);
    }
  });

  it("una suscripción viva SIN periodEnd no cubre (no se sabe hasta cuándo)", () => {
    const e = evaluarVigencia({
      validUntil: "2026-10-01T00:00:00.000Z",
      suscripcion: { status: "ACTIVE", periodEnd: null },
      ahora: AHORA,
    });
    expect(e.vigente).toBe(false);
  });

  it("el día exacto del corte todavía cuenta como vigente, no se corta por milisegundos", () => {
    expect(evaluarVigencia({ validUntil: AHORA.toISOString(), ahora: AHORA }).vigente).toBe(true);
  });
});

describe("un JSON con basura no puede decidir un corte de servicio", () => {
  it("valores no usables se tratan como «sin fecha», no como vencido", () => {
    for (const basura of ["", "   ", "ayer", "2026-13-45", 0, 123, true, {}, [], NaN]) {
      const e = evaluarVigencia({ validUntil: basura as unknown, ahora: AHORA });
      expect(e.vigente, `${JSON.stringify(basura)} no debe bloquear`).toBe(true);
      expect(e.motivo).toBe("sin_vencimiento");
    }
  });

  it("un periodEnd ilegible no inventa cobertura", () => {
    const e = evaluarVigencia({
      validUntil: "2026-10-01T00:00:00.000Z",
      suscripcion: { status: "ACTIVE", periodEnd: "cuando sea" },
      ahora: AHORA,
    });
    expect(e.vigente).toBe(false);
  });
});

describe("atajo y frase", () => {
  it("servicioVigente devuelve lo mismo que evaluarVigencia", () => {
    const entrada = { validUntil: "2026-10-01T00:00:00.000Z", suscripcion: null, ahora: AHORA };
    expect(servicioVigente(entrada)).toBe(evaluarVigencia(entrada).vigente);
  });

  it("la frase solo existe cuando está vencida y no nombra columnas", () => {
    const vencida = evaluarVigencia({ validUntil: "2026-01-01T00:00:00.000Z", ahora: AHORA });
    const frase = frasePorVigenciaVencida(vencida);
    expect(frase).toContain("venció");
    expect(frase).not.toMatch(/validUntil|settings|period_end/i);
    expect(frasePorVigenciaVencida(evaluarVigencia({ validUntil: null, ahora: AHORA }))).toBe("");
  });
});
