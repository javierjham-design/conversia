import { randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { getEnv } from "@conversia/config";

/**
 * Emisión y verificación de JWT endurecidas (ASVS 3.5 / API2:2023):
 * - Algoritmo FIJADO a HS256 (previene algorithm confusion y `alg:none`).
 * - issuer + audience validados (rechaza tokens de otro emisor/uso).
 * - jti único por token (base para revocación futura).
 * - Verificación explícita de expiración con tolerancia mínima de reloj.
 */
export interface AppTokenClaims {
  sub: string;
  orgId: string;
  role: string;
  perms: string[];
}

const ALGO: jwt.Algorithm = "HS256";

export function signAppToken(claims: AppTokenClaims): string {
  const env = getEnv();
  return jwt.sign({ ...claims, jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyAppToken(token: string): AppTokenClaims {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGO], // sólo HS256 — cualquier otro (none, RS256…) se rechaza
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    clockTolerance: 5,
  }) as jwt.JwtPayload;

  if (!decoded.sub || !decoded.orgId || !decoded.role) {
    throw new Error("Token sin claims obligatorios");
  }
  return {
    sub: String(decoded.sub),
    orgId: String(decoded.orgId),
    role: String(decoded.role),
    perms: Array.isArray(decoded.perms) ? (decoded.perms as string[]) : [],
  };
}
