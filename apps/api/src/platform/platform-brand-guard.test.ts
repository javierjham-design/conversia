import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { assertTubotBrand, platformReqBrand, type PlatformRequest } from "./platform.guard";

/**
 * §6.2 — Las credenciales globales de pago (Flow/Lemon) las comparten ambas marcas. Un admin de
 * Conversia no debe poder pisarlas: las escrituras globales quedan bloqueadas salvo para TuBot.
 */
const req = (brand?: string) => ({ platformAdmin: brand ? { brand } : undefined }) as unknown as PlatformRequest;

describe("assertTubotBrand (§6.2)", () => {
  it("permite a TuBot y al default sin marca (comportamiento histórico)", () => {
    expect(() => assertTubotBrand(req("tubot"))).not.toThrow();
    expect(() => assertTubotBrand(req())).not.toThrow();
  });

  it("rechaza a Conversia con 403", () => {
    expect(() => assertTubotBrand(req("conversia"))).toThrow(ForbiddenException);
  });

  it("platformReqBrand usa tubot por defecto", () => {
    expect(platformReqBrand(req())).toBe("tubot");
    expect(platformReqBrand(req("conversia"))).toBe("conversia");
  });
});
