import { beforeAll, describe, expect, it } from "vitest";
import * as jwt from "jsonwebtoken";

// Env necesario para firmar/verificar el token de plataforma (se cachea en la 1ª llamada).
beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-para-jwt-endurecido-1234567890";
  process.env.JWT_ISSUER = "conversia";
  process.env.SUPER_ADMIN_SESSION_HOURS = "8";
});

describe("Token de super admin — marca (D8)", () => {
  it("firma y verifica preservando la marca", async () => {
    const { signPlatformToken, verifyPlatformToken } = await import("../src/platform/platform.jwt");
    const token = signPlatformToken({ sub: "a1", email: "x@y.cl", role: "owner", brand: "conversia", jti: "j1" });
    const claims = verifyPlatformToken(token);
    expect(claims.sub).toBe("a1");
    expect(claims.brand).toBe("conversia");
    expect(claims.role).toBe("owner");
  });

  it("un token sin claim de marca (emitido antes de D8) se verifica como tubot", async () => {
    const { verifyPlatformToken } = await import("../src/platform/platform.jwt");
    // Token legacy: mismo secreto/issuer/audiencia pero SIN brand ni platform:true? → platform:true sí.
    const legacy = jwt.sign(
      { sub: "a2", email: "z@y.cl", role: "owner", platform: true },
      process.env.JWT_SECRET!,
      { algorithm: "HS256", issuer: "conversia", audience: "conversia-platform", jwtid: "j2" },
    );
    const claims = verifyPlatformToken(legacy);
    expect(claims.brand).toBe("tubot");
  });
});
