import { describe, expect, it } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import * as bcryptMod from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { getEnv } from "@conversia/config";
import { AuthService } from "../src/auth/auth.service";
import { signAppToken, verifyAppToken } from "../src/auth/jwt";
import { parseDurationSeconds, techoDeLaSesion, vidaDelAccessToken } from "../src/auth/refresh-session.service";
import { TenancyMiddleware } from "../src/tenancy/tenancy.middleware";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

/**
 * LA SESIÓN DEL PANEL DURA 24 HORAS COMO MÁXIMO.
 *
 * Hallazgo del dueño (2026-11-03): entraba a conversia.cl, apretaba "Ir a mi panel" y pasaba
 * directo a la plataforma, días después de haber entrado. No era un bug suelto: la política
 * decía 30 d de ventana deslizante con techo de 90 d, y encima el access token (JWT stateless
 * de 12 h, sin lista de revocación) podía emitirse JUSTO antes del techo y sobrevivirlo 12 h
 * más. Tres cosas tenían que cambiar a la vez, y este archivo las fija:
 *
 *  1. el techo baja a 24 h y se aplica a las sesiones YA ABIERTAS (una política nueva solo
 *     puede ACORTAR la vida de una sesión viva, nunca alargarla);
 *  2. ningún access token puede vivir más allá del techo de su sesión (se le recorta el `exp`
 *     y además lleva el techo firmado en el claim `sxp`, que el middleware revisa);
 *  3. cambiar de organización NO estrena techo — si lo estrenara, un cliente podría renovar
 *     su sesión para siempre llamando a /auth/switch-org cada 23 h.
 *
 * TuBot no entra acá: nunca recibió refresh token (§10.2), así que su sesión siempre fue el
 * access de 12 h. Los tests del final prueban que sigue IDÉNTICO.
 */

const SEG = 1000;
const HORA = 3_600 * SEG;
const DIA = 24 * HORA;

/** `exp` del token, en ms. Sin verificar la firma: acá interesa la fecha, no la validez. */
function expEnMs(token: string): number {
  return ((jwt.decode(token) as { exp: number }).exp ?? 0) * 1000;
}

function makeAuth(opts: { brand?: string; techo?: number; creadaHace?: number } = {}) {
  const brand = opts.brand ?? "conversia";
  const techo = opts.techo ?? Date.now() + DIA;
  const creadaHace = opts.creadaHace ?? 0;
  /** Lo que se le pidió a Redis: sirve para probar qué techo se HEREDÓ en cada caso. */
  const creadas: Array<{ userId: string; orgId: string; hereda?: number }> = [];

  const memberships = [{ organizationId: "o1", roleId: "r1", active: true }];
  const user = {
    id: "u1",
    email: "d@x.cl",
    brand,
    passwordHash: bcrypt.hashSync("clave-correcta-1", 4),
    mfaEnabled: false,
    memberships,
  };
  const admin: any = {
    user: { findUnique: async () => user, update: async () => user },
    role: { findUnique: async () => ({ id: "r1", code: "owner", permissions: ["*"] }) },
    organization: { findUnique: async () => ({ settings: {}, deletedAt: null }) },
    organizationUser: { findUnique: async () => ({ organizationId: "o1", userId: "u1", roleId: "r1", active: true }) },
  };
  const sesion = { userId: "u1", orgId: "o1", createdAt: Date.now() - creadaHace, absoluteExpiresAt: techo };
  const refreshSessions: any = {
    create: async (userId: string, orgId: string, hereda?: number) => {
      creadas.push({ userId, orgId, hereda });
      return { token: "rt_nuevo", absoluteExpiresAt: hereda ?? Date.now() + DIA };
    },
    resolve: async () => sesion,
    rotate: async (_usado: string, data: any) => ({ token: "rt_rotado", absoluteExpiresAt: techoDeLaSesion(data, DIA) }),
    revoke: async () => undefined,
  };
  const service = new AuthService({ admin } as any, {} as any, refreshSessions, { capi: { add: async () => undefined } } as any);
  return { service, creadas, techo };
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. La política EN VIGOR (no solo el código que la aplica)
// ─────────────────────────────────────────────────────────────────────────────
describe("la configuración en vigor no deja pasar de 24 h", () => {
  // Lee la configuración EFECTIVA (env > default), no el default escrito en el schema: si
  // mañana alguien pone JWT_REFRESH_ABSOLUTE_MAX="30d" en un .env o en el CI, esto se pone
  // rojo. En Railway no lo ve nadie, y por eso el despliegue lleva su propia comprobación.
  it("el techo absoluto de la sesión es de 24 h o menos", () => {
    expect(parseDurationSeconds(getEnv().JWT_REFRESH_ABSOLUTE_MAX)).toBeLessThanOrEqual(24 * 3600);
  });

  it("la ventana deslizante tampoco pasa de 24 h", () => {
    expect(parseDurationSeconds(getEnv().JWT_REFRESH_EXPIRES_IN)).toBeLessThanOrEqual(24 * 3600);
  });

  it("el access token no dura más que el techo (si durara, lo sobreviviría)", () => {
    const access = parseDurationSeconds(getEnv().JWT_EXPIRES_IN, 12 * 3600);
    expect(access).toBeLessThanOrEqual(parseDurationSeconds(getEnv().JWT_REFRESH_ABSOLUTE_MAX));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. El techo se aplica a las sesiones que YA estaban abiertas
// ─────────────────────────────────────────────────────────────────────────────
describe("el techo nuevo alcanza a las sesiones ya abiertas", () => {
  it("una sesión con techo guardado de 90 d muere igual a las 24 h del login", () => {
    // Es el caso del dueño: su sesión se creó cuando la política eran 90 días y el techo
    // quedó GUARDADO en Redis. Si `techoDeLaSesion` respetara ese dato sin más, bajar la
    // política no cerraría ninguna de las sesiones que están abiertas hoy — justo las que
    // hay que cerrar. Una política nueva solo puede acortar.
    const login = Date.now() - 3 * DIA;
    const vieja = { createdAt: login, absoluteExpiresAt: login + 90 * DIA };
    expect(techoDeLaSesion(vieja, DIA)).toBe(login + DIA);
    expect(techoDeLaSesion(vieja, DIA)).toBeLessThan(Date.now()); // ya vencida → re-login
  });

  it("si el techo guardado es MÁS CORTO que la política, manda el guardado", () => {
    // El otro lado de la misma regla: el mínimo de los dos, nunca el máximo.
    const login = Date.now();
    const corta = { createdAt: login, absoluteExpiresAt: login + 2 * HORA };
    expect(techoDeLaSesion(corta, DIA)).toBe(login + 2 * HORA);
  });

  it("una sesión sin techo guardado lo cuenta desde su login, no desde ahora", () => {
    const login = Date.now() - 2 * DIA;
    expect(techoDeLaSesion({ createdAt: login }, DIA)).toBe(login + DIA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ningún access token sobrevive al techo
// ─────────────────────────────────────────────────────────────────────────────
describe("vidaDelAccessToken", () => {
  it("usa el access configurado mientras el techo esté lejos", () => {
    const now = Date.now();
    expect(vidaDelAccessToken("12h", now + DIA, now)).toBe(12 * 3600);
  });

  it("lo RECORTA cuando el techo está más cerca que el access", () => {
    // El agujero exacto: un refresh a las 23 h 50 min entregaba un token de 12 h → la sesión
    // llegaba a 35 h 50 min pese a un techo de 24 h, y no hay lista de revocación del access.
    const now = Date.now();
    expect(vidaDelAccessToken("12h", now + 10 * 60 * SEG, now)).toBe(600);
  });

  it("nunca devuelve 0 ni negativo (jsonwebtoken rechaza un expiresIn ≤ 0)", () => {
    const now = Date.now();
    expect(vidaDelAccessToken("12h", now, now)).toBe(1);
    expect(vidaDelAccessToken("12h", now - DIA, now)).toBe(1);
  });

  it("ante un JWT_EXPIRES_IN ilegible cae a 12 h, no a eterno", () => {
    const now = Date.now();
    expect(vidaDelAccessToken(undefined, now + 30 * DIA, now)).toBe(12 * 3600);
    expect(vidaDelAccessToken("ni idea", now + 30 * DIA, now)).toBe(12 * 3600);
  });
});

describe("/auth/refresh no puede estirar la sesión más allá del techo", () => {
  it("el access token que emite muere con la sesión, no 12 h después", async () => {
    const quedan = 10 * 60 * SEG; // quedan 10 minutos de techo
    const { service, techo } = makeAuth({ techo: Date.now() + quedan });
    const r: any = await service.refresh("rt_viejo");
    expect(expEnMs(r.token)).toBeLessThanOrEqual(techo + SEG);
  });

  it("el token lleva el techo firmado (`sxp`) para que nadie lo reinterprete", async () => {
    const { service, techo } = makeAuth({ techo: Date.now() + 2 * HORA });
    const r: any = await service.refresh("rt_viejo");
    expect(verifyAppToken(r.token).sxp).toBe(Math.floor(techo / 1000));
  });

  it("le dice al cliente cuándo muere la sesión (para no ofrecerle un panel al que no entra)", async () => {
    const { service, techo } = makeAuth({ techo: Date.now() + 2 * HORA });
    const r: any = await service.refresh("rt_viejo");
    expect(r.sessionExpiresAt).toBe(new Date(techo).toISOString());
  });

  it("con el techo lejos, el access conserva su duración normal", async () => {
    const { service } = makeAuth({ techo: Date.now() + DIA });
    const r: any = await service.refresh("rt_viejo");
    const horas = (expEnMs(r.token) - Date.now()) / HORA;
    expect(horas).toBeGreaterThan(11.9);
    expect(horas).toBeLessThan(12.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cambiar de organización no estrena techo
// ─────────────────────────────────────────────────────────────────────────────
describe("switch-org no renueva la sesión", () => {
  it("hereda el techo de la sesión en curso en vez de estrenar uno", async () => {
    // Sin esto, cualquiera con una sesión viva podía mantenerla eterna llamando a
    // /auth/switch-org (incluso a su MISMA organización) cada 23 h: el techo volvía a 24 h.
    const { service, creadas } = makeAuth();
    const techoEnCurso = Date.now() + 2 * HORA;
    const r: any = await service.switchOrg("u1", "o1", undefined, techoEnCurso);
    expect(creadas[0].hereda).toBe(techoEnCurso);
    expect(verifyAppToken(r.token).sxp).toBe(Math.floor(techoEnCurso / 1000));
    expect(expEnMs(r.token)).toBeLessThanOrEqual(techoEnCurso + SEG);
  });

  it("sin techo en curso (sesión vieja, sin `sxp`) estrena uno de 24 h, no uno eterno", async () => {
    const { service, creadas } = makeAuth();
    const r: any = await service.switchOrg("u1", "o1", undefined, undefined);
    expect(creadas[0].hereda).toBeUndefined();
    const horas = (Date.parse(r.sessionExpiresAt) - Date.now()) / HORA;
    expect(horas).toBeGreaterThan(23.9);
    expect(horas).toBeLessThanOrEqual(24);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. El middleware hace valer el techo (defensa en profundidad)
// ─────────────────────────────────────────────────────────────────────────────
describe("el middleware rechaza un token cuya sesión ya murió", () => {
  const mw = new TenancyMiddleware();
  const pedido = (token: string): Request =>
    ({ originalUrl: "/clientes", headers: { authorization: `Bearer ${token}` } }) as unknown as Request;
  const correr = (token: string) => mw.use(pedido(token), {} as Response, (() => undefined) as NextFunction);

  it("un `sxp` ya pasado corta, aunque el `exp` del token siga vivo", () => {
    // El recorte del `exp` ya debería hacer imposible este token; esto es el cinturón por si
    // mañana alguien agrega otro camino que emita sesiones y se olvide de recortar.
    const token = signAppToken(
      { sub: "u1", orgId: "o1", role: "owner", perms: ["*"], sxp: Math.floor((Date.now() - HORA) / 1000) },
      { expiresIn: "12h" },
    );
    expect(() => correr(token)).toThrowError(UnauthorizedException);
  });

  it("un `sxp` futuro pasa", () => {
    const token = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"], sxp: Math.floor((Date.now() + HORA) / 1000) });
    expect(() => correr(token)).not.toThrow();
  });

  it("un token SIN `sxp` pasa igual (TuBot y el token MCP de 365 d no lo llevan)", () => {
    const token = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"] });
    expect(() => correr(token)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. REGRESIÓN TuBot — su sesión no cambió en nada
// ─────────────────────────────────────────────────────────────────────────────
describe("REGRESIÓN TuBot: su login sigue idéntico", () => {
  it("no recibe refresh, ni techo, ni `sxp`, y su access sigue durando 12 h", async () => {
    const { service, creadas } = makeAuth({ brand: "tubot" });
    const r: any = await service.login({ email: "d@x.cl", password: "clave-correcta-1", brand: "tubot" });
    expect(r.refreshToken).toBeUndefined();
    expect(r.sessionExpiresAt).toBeUndefined();
    expect(creadas.length).toBe(0); // no se creó sesión en Redis
    expect(verifyAppToken(r.token).sxp).toBeUndefined();
    const horas = (expEnMs(r.token) - Date.now()) / HORA;
    expect(horas).toBeGreaterThan(11.9);
    expect(horas).toBeLessThan(12.1);
  });

  it("Conversia sí: refresh + techo de 24 h + `sxp` recortado", async () => {
    const { service, creadas } = makeAuth({ brand: "conversia" });
    const r: any = await service.login({ email: "d@x.cl", password: "clave-correcta-1", brand: "conversia" });
    expect(r.refreshToken).toBe("rt_nuevo");
    expect(creadas.length).toBe(1);
    const sxp = verifyAppToken(r.token).sxp;
    expect(typeof sxp).toBe("number");
    const horas = (sxp! * 1000 - Date.now()) / HORA;
    expect(horas).toBeGreaterThan(23.9);
    expect(horas).toBeLessThanOrEqual(24);
  });
});
