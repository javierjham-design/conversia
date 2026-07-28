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
  role: string; // owner | admin | support | billing | readonly
  jti: string; // enlaza a la sesión revocable en Redis
}

/** Secreto propio del Super Admin (separado del de tenant); cae a JWT_SECRET si no se configuró. */
function platformSecret(): string {
  const env = getEnv();
  return env.SUPER_ADMIN_SESSION_SECRET || env.JWT_SECRET;
}

export function signPlatformToken(claims: PlatformClaims): string {
  const env = getEnv();
  const { jti, ...rest } = claims;
  return jwt.sign({ ...rest, platform: true }, platformSecret(), {
    algorithm: ALGO,
    issuer: env.JWT_ISSUER,
    audience: PLATFORM_AUDIENCE,
    jwtid: jti, // el jti apunta a la sesión revocable en Redis
    expiresIn: `${env.SUPER_ADMIN_SESSION_HOURS}h`,
  } as jwt.SignOptions);
}

export function verifyPlatformToken(token: string): PlatformClaims {
  const env = getEnv();
  const decoded = jwt.verify(token, platformSecret(), {
    algorithms: [ALGO],
    issuer: env.JWT_ISSUER,
    audience: PLATFORM_AUDIENCE,
    clockTolerance: 5,
  }) as jwt.JwtPayload;
  if (!decoded.sub || decoded.platform !== true) throw new Error("Token de plataforma inválido");
  return {
    sub: String(decoded.sub),
    email: String(decoded.email ?? ""),
    role: String(decoded.role ?? "owner"),
    jti: String(decoded.jti ?? ""),
  };
}
