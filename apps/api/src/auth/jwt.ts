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

export function signAppToken(
  claims: AppTokenClaims,
  opts?: { expiresIn?: string | number; extra?: Record<string, unknown> },
): string {
  const env = getEnv();
  // `extra` permite marcar un token de impersonación (claim `imp` = id del super
  // admin) con expiración corta, sin abrir la superficie del token normal.
  return jwt.sign({ ...claims, ...(opts?.extra ?? {}), jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: opts?.expiresIn ?? env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Token PENDIENTE de MFA: audiencia distinta (`${AUD}:mfa`) → el middleware de
 * tenancy (que exige la audiencia normal) lo rechaza, así NO da acceso a la app;
 * solo sirve para completar el 2.º factor o el enrolamiento forzado. Vida corta.
 */
export function signMfaToken(userId: string, purpose: "verify" | "setup"): string {
  const env = getEnv();
  return jwt.sign({ sub: userId, purpose, jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:mfa`,
    expiresIn: "10m",
  } as jwt.SignOptions);
}

export function verifyMfaToken(token: string, purpose: "verify" | "setup"): { sub: string } {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGO],
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:mfa`,
    clockTolerance: 5,
  }) as jwt.JwtPayload;
  if (!decoded.sub || decoded.purpose !== purpose) throw new Error("Token MFA inválido");
  return { sub: String(decoded.sub) };
}

/**
 * Token de INVITACIÓN: audiencia propia (`${AUD}:invite`) → no sirve para entrar
 * a la app, solo para que el invitado fije su contraseña vía link. `fresh` marca
 * si la cuenta se creó recién (necesita contraseña) o ya existía. Vida 7 días.
 */
export function signInviteToken(userId: string, fresh: boolean): string {
  const env = getEnv();
  return jwt.sign({ sub: userId, fresh, purpose: "invite", jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:invite`,
    expiresIn: "7d",
  } as jwt.SignOptions);
}

export function verifyInviteToken(token: string): { sub: string; fresh: boolean } {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGO],
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:invite`,
    clockTolerance: 5,
  }) as jwt.JwtPayload;
  if (!decoded.sub || decoded.purpose !== "invite") throw new Error("Token de invitación inválido");
  return { sub: String(decoded.sub), fresh: decoded.fresh === true };
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
