import { beforeAll, describe, expect, it } from "vitest";
import * as jwt from "jsonwebtoken";
import { signPlatformToken, verifyPlatformToken } from "../src/platform/platform.jwt";

// Env necesario para firmar/verificar el token de plataforma (getEnv se cachea en la 1ª
// llamada, no al importar → basta con setearlo en beforeAll, igual que jwt.spec.ts).
beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-para-jwt-endurecido-1234567890";
  process.env.JWT_ISSUER = "conversia";
  process.env.SUPER_ADMIN_SESSION_HOURS = "8";
});

describe("Token de super admin — marca (D8)", () => {
  it("firma y verifica preservando la marca", () => {
    const token = signPlatformToken({ sub: "a1", email: "x@y.cl", role: "owner", brand: "conversia", jti: "j1" });
    const claims = verifyPlatformToken(token);
    expect(claims.sub).toBe("a1");
    expect(claims.brand).toBe("conversia");
    expect(claims.role).toBe("owner");
  });

  it("un token sin claim de marca (emitido antes de D8) se verifica como tubot", () => {
    // Token legacy: mismo secreto/issuer/audiencia y platform:true, pero SIN brand.
    const legacy = jwt.sign(
      { sub: "a2", email: "z@y.cl", role: "owner", platform: true },
      process.env.JWT_SECRET!,
      { algorithm: "HS256", issuer: "conversia", audience: "conversia-platform", jwtid: "j2" },
    );
    const claims = verifyPlatformToken(legacy);
    expect(claims.brand).toBe("tubot");
  });
});
