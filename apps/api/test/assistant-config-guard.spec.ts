import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { assertConversiaBrand, assertTubotBrand, platformReqBrand, type PlatformRequest } from "../src/platform/platform.guard";
import { operatorMayAccess } from "../src/platform/platform-policy";

/**
 * Quién puede cambiarle el proveedor y el modelo a Convi.
 *
 * Convi es el copiloto de CONVERSIA, pero su configuración es UNA fila global
 * (`platform_settings.assistant`). Esa asimetría es la trampa: sin guarda, un admin de TuBot
 * le cambiaría el modelo al asistente de la otra marca, y un operador —que puede operar la
 * ficha de cualquier cliente— tocaría una palanca que afecta a TODOS a la vez y que gasta
 * llamadas pagas con las llaves de la plataforma.
 */

const req = (brand?: string) => ({ platformAdmin: brand ? { brand } : undefined }) as unknown as PlatformRequest;

describe("assertConversiaBrand", () => {
  it("deja pasar al super admin de Conversia", () => {
    expect(() => assertConversiaBrand(req("conversia"))).not.toThrow();
  });

  it("bloquea al admin de TuBot (es el copiloto de la otra marca)", () => {
    expect(() => assertConversiaBrand(req("tubot"))).toThrow(ForbiddenException);
  });

  it("falla cerrado: sin marca en el token, no pasa", () => {
    // `platformReqBrand` cae a "tubot" por compatibilidad histórica, así que un token viejo
    // o sin marca NO puede escribir la configuración de Convi.
    expect(platformReqBrand(req())).toBe("tubot");
    expect(() => assertConversiaBrand(req())).toThrow(ForbiddenException);
  });

  it("es la contraparte de assertTubotBrand, no un duplicado", () => {
    // La misma petición no puede pasar las dos: si lo hiciera, una de las dos no filtra nada.
    expect(() => assertTubotBrand(req("tubot"))).not.toThrow();
    expect(() => assertConversiaBrand(req("tubot"))).toThrow();
    expect(() => assertConversiaBrand(req("conversia"))).not.toThrow();
    expect(() => assertTubotBrand(req("conversia"))).toThrow();
  });
});

describe("el configurador de Convi no es del operador", () => {
  for (const ruta of ["/platform/assistant", "/platform/assistant/config", "/platform/assistant/test"]) {
    it(`deniega ${ruta}`, () => expect(operatorMayAccess(ruta)).toBe(false));
  }

  it("tampoco esquivándolo con mayúsculas o querystring", () => {
    expect(operatorMayAccess("/platform/Assistant/config")).toBe(false);
    expect(operatorMayAccess("/platform/assistant/test?x=1")).toBe(false);
  });
});
