import { createHash, randomUUID } from "node:crypto";
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
  /**
   * §3.2 — id del super admin que está IMPERSONANDO a este usuario. Presente solo en
   * los tokens que emite `POST /platform/organizations/:id/impersonate`. Viaja hasta el
   * contexto del request para que las acciones de cuenta (cambiar contraseña, MFA,
   * cambiar de organización, editar el perfil) se puedan negar: el super admin entra a
   * VER y operar la ficha, no a apropiarse de la cuenta del cliente.
   */
  imp?: string;
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

/**
 * Token de VERIFICACIÓN DE CORREO (D6): audiencia propia (`${AUD}:email`) → no sirve
 * para entrar a la app, solo para confirmar el correo vía link. Vida 2 días.
 */
export function signEmailVerifyToken(userId: string): string {
  const env = getEnv();
  return jwt.sign({ sub: userId, purpose: "email_verify", jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:email`,
    expiresIn: "2d",
  } as jwt.SignOptions);
}

export function verifyEmailVerifyToken(token: string): { sub: string } {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGO],
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:email`,
    clockTolerance: 5,
  }) as jwt.JwtPayload;
  if (!decoded.sub || decoded.purpose !== "email_verify") throw new Error("Token de verificación inválido");
  return { sub: String(decoded.sub) };
}

/**
 * §10.5 — Token de RECUPERACIÓN DE CONTRASEÑA. Audiencia propia (`${AUD}:reset`) → no
 * sirve para entrar a la app, solo para fijar una contraseña nueva. Vive 1 hora.
 *
 * `pwd` es una huella de la contraseña ACTUAL. Es lo que hace el token de UN SOLO USO sin
 * guardar nada en base ni en Redis: al cambiar la contraseña la huella deja de coincidir,
 * así que el enlace usado —y cualquier otro que se haya pedido antes— queda inservible al
 * instante. Sin esto, un enlace filtrado (del correo, de un reenvío) seguiría abriendo la
 * cuenta durante toda la hora, incluso después de haberlo usado.
 */
export function signPasswordResetToken(userId: string, pwdFingerprint: string): string {
  const env = getEnv();
  return jwt.sign({ sub: userId, pwd: pwdFingerprint, purpose: "password_reset", jti: randomUUID() }, env.JWT_SECRET, {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:reset`,
    expiresIn: "1h",
  } as jwt.SignOptions);
}

export function verifyPasswordResetToken(token: string): { sub: string; pwd: string } {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGO],
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:reset`,
    clockTolerance: 5,
  }) as jwt.JwtPayload;
  if (!decoded.sub || decoded.purpose !== "password_reset" || typeof decoded.pwd !== "string") {
    throw new Error("Token de recuperación inválido");
  }
  return { sub: String(decoded.sub), pwd: decoded.pwd };
}

/** Huella corta de la contraseña actual, para atar el token a ella (ver arriba). */
export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 32);
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
    // §3.2: el claim `imp` se propaga tal cual; sin él, sesión normal del cliente.
    ...(decoded.imp ? { imp: String(decoded.imp) } : {}),
  };
}
