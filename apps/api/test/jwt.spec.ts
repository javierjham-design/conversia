import { beforeAll, describe, expect, it } from "vitest";
import * as jwt from "jsonwebtoken";
import { signAppToken, verifyAppToken } from "../src/auth/jwt";

// getEnv se cachea en la 1ª llamada (dentro de signAppToken), no al importar.
beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-para-jwt-endurecido-1234567890";
  process.env.JWT_ISSUER = "conversia";
  process.env.JWT_AUDIENCE = "conversia-api";
});

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("JWT endurecido", () => {
  it("firma y verifica ida y vuelta", () => {
    const token = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"] });
    const claims = verifyAppToken(token);
    expect(claims.sub).toBe("u1");
    expect(claims.orgId).toBe("o1");
    expect(claims.perms).toEqual(["*"]);
  });

  it("rechaza un token 'alg:none' (algorithm confusion)", () => {
    const header = b64url({ alg: "none", typ: "JWT" });
    const payload = b64url({ sub: "attacker", orgId: "victima", role: "owner", iss: "conversia", aud: "conversia-api" });
    const forged = `${header}.${payload}.`; // sin firma
    expect(() => verifyAppToken(forged)).toThrow();
  });

  it("rechaza un token firmado con otro secreto", () => {
    const bad = jwt.sign({ sub: "x", orgId: "y", role: "owner" }, "OTRO-SECRETO", {
      algorithm: "HS256",
      issuer: "conversia",
      audience: "conversia-api",
    });
    expect(() => verifyAppToken(bad)).toThrow();
  });

  it("rechaza audiencia incorrecta", () => {
    const bad = jwt.sign({ sub: "x", orgId: "y", role: "owner" }, process.env.JWT_SECRET!, {
      algorithm: "HS256",
      issuer: "conversia",
      audience: "otra-app",
    });
    expect(() => verifyAppToken(bad)).toThrow();
  });
});
