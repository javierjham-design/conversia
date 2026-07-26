import { randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { getEnv } from "@conversia/config";

/**
 * JWT de ADMINISTRADOR DE PLATAFORMA — identidad y audiencia SEPARADAS de los
 * tokens de tenant. Un token de tenant no puede acceder a rutas de plataforma
 * ni viceversa (distinta `audience`). El admin de plataforma opera cross-tenant
 * por diseño (usa el cliente admin de BD) y toda acción queda auditada.
 */
const ALGO: jwt.Algorithm = "HS256";
const PLATFORM_AUDIENCE = "conversia-platform";

export interface PlatformClaims {
  sub: string; // platform_admin id
  email: string;
}

export function signPlatformToken(claims: PlatformClaims): string {
  const env = getEnv();
  return jwt.sign({ ...claims, platform: true, jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: PLATFORM_AUDIENCE,
    expiresIn: "8h",
  } as jwt.SignOptions);
}

export function verifyPlatformToken(token: string): PlatformClaims {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGO],
    issuer: env.JWT_ISSUER,
    audience: PLATFORM_AUDIENCE,
    clockTolerance: 5,
  }) as jwt.JwtPayload;
  if (!decoded.sub || decoded.platform !== true) throw new Error("Token de plataforma inválido");
  return { sub: String(decoded.sub), email: String(decoded.email ?? "") };
}
