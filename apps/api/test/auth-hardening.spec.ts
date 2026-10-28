import { describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService, wantsSlidingSession } from "../src/auth/auth.service";
import { ConversationsController } from "../src/conversations/conversations.controller";
import { ReportsController } from "../src/reports/reports.controller";
import { UsersController } from "../src/users/users.controller";
import { AuthController } from "../src/auth/auth.controller";
import { TenancyMiddleware } from "../src/tenancy/tenancy.middleware";
import { clientIp, sessionMode } from "../src/auth/auth.controller";
import { isMfaExempt, clientIp as platformClientIp } from "../src/platform/platform.guard";
import { signAppToken, verifyAppToken } from "../src/auth/jwt";
import { assertNotImpersonating, runWithContext, type RequestContext } from "../src/tenancy/context";
import { encryptSecret } from "../src/common/crypto";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, totpForCounter } from "../src/auth/totp";
import * as bcryptMod from "bcryptjs";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

// Etapa 5 de la auditoría — autenticación y permisos. Cada bloque fija un agujero
// concreto del informe para que no vuelva a abrirse.

/** Código TOTP válido AHORA para un secreto dado (el mismo cálculo que `verifyTotp`). */
function codigoVigente(secret: string): string {
  return totpForCounter(secret, Math.floor(Date.now() / 1000 / 30));
}

const req = (over: Partial<Request> = {}): Request => ({ headers: {}, ...over }) as Request;

// ─────────────────────────────────────────────────────────────────────────────
// §10.2 — el refresh token solo para quien usa la sesión deslizante
// ─────────────────────────────────────────────────────────────────────────────
describe("§10.2 — a quién se le emite refresh token", () => {
  it("conversia sí (su panel refresca en el 401)", () => {
    expect(wantsSlidingSession({ brand: "conversia" })).toBe(true);
    expect(wantsSlidingSession({ brand: "CONVERSIA" })).toBe(true);
  });
  it("tubot no (su panel nunca lo lee)", () => {
    expect(wantsSlidingSession({ brand: "tubot" })).toBe(false);
    expect(wantsSlidingSession({})).toBe(false);
    expect(wantsSlidingSession()).toBe(false);
  });
  it("cualquier cliente lo pide con x-session-mode: sliding", () => {
    expect(wantsSlidingSession({ brand: "tubot", sessionMode: "sliding" })).toBe(true);
    expect(wantsSlidingSession({ brand: "tubot", sessionMode: " SLIDING " })).toBe(true);
    expect(wantsSlidingSession({ brand: "tubot", sessionMode: "fija" })).toBe(false);
  });
  it("la cabecera se lee del request", () => {
    expect(sessionMode(req({ headers: { "x-session-mode": "sliding" } }))).toBe("sliding");
    expect(sessionMode(req())).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 — IP real: la cabecera X-Forwarded-For ya no manda
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.7 — la IP del cliente no se puede falsificar", () => {
  it("auth: ignora X-Forwarded-For y usa req.ip", () => {
    const r = req({ headers: { "x-forwarded-for": "1.2.3.4" }, ip: "10.0.0.7" } as Partial<Request>);
    expect(clientIp(r)).toBe("10.0.0.7");
  });
  it("platform: idem (la allowlist de IP del super admin dependía de esto)", () => {
    const r = req({ headers: { "x-forwarded-for": "190.1.1.1" }, ip: "10.0.0.9" } as Partial<Request>);
    expect(platformClientIp(r)).toBe("10.0.0.9");
  });
  it("sin req.ip cae al socket, nunca a la cabecera", () => {
    const r = req({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.1" } } as any);
    expect(clientIp(r)).toBe("10.0.0.1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.10 — la exención de MFA del panel no se cuelga de la query string
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.10 — exención de MFA por PATH, no por substring", () => {
  it("las rutas de autenticación siguen exentas", () => {
    expect(isMfaExempt(req({ originalUrl: "/platform/auth/login" } as any))).toBe(true);
    expect(isMfaExempt(req({ originalUrl: "/platform/auth/mfa/enroll?x=1" } as any))).toBe(true);
  });
  it("NO se exime una ruta del panel por llevar el prefijo en la query", () => {
    expect(isMfaExempt(req({ originalUrl: "/platform/plans?x=/platform/auth/" } as any))).toBe(false);
    expect(isMfaExempt(req({ originalUrl: "/platform/organizations?redir=/platform/auth/login" } as any))).toBe(false);
  });
  it("tampoco si el prefijo va en medio del path", () => {
    expect(isMfaExempt(req({ originalUrl: "/platform/x/platform/auth/y" } as any))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 — impersonación: el claim viaja y las acciones de cuenta se niegan
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.2 — sesión de impersonación", () => {
  it("el claim `imp` sobrevive al firmado y la verificación del token", () => {
    const token = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"] }, { extra: { imp: "sa_1" } });
    expect(verifyAppToken(token).imp).toBe("sa_1");
  });
  it("un token normal no trae `imp`", () => {
    const token = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"] });
    expect(verifyAppToken(token).imp).toBeUndefined();
  });
  it("una acción de cuenta se rechaza con 403 y dice por qué", () => {
    expect(() => assertNotImpersonating({ impersonatedBy: "sa_1" }, "cambiar la contraseña")).toThrowError(ForbiddenException);
    try {
      assertNotImpersonating({ impersonatedBy: "sa_1" }, "cambiar la contraseña");
    } catch (e) {
      expect((e as ForbiddenException).message).toContain("cambiar la contraseña");
      expect((e as ForbiddenException).message).toMatch(/super admin/i);
    }
  });
  it("sin impersonación no molesta", () => {
    expect(() => assertNotImpersonating({}, "cambiar la contraseña")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 / §3.4 / §3.9 — AuthService
// ─────────────────────────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  email: string;
  brand: string;
  passwordHash: string;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaRecoveryCodes: string[];
}

function makeAuth(opts: {
  user?: Partial<FakeUser>;
  org?: { deletedAt?: Date | null; settings?: unknown };
  membership?: boolean;
} = {}) {
  const secret = generateTotpSecret();
  const user: FakeUser = {
    id: "u1",
    email: "d@x.cl",
    brand: "tubot",
    passwordHash: bcrypt.hashSync("clave-correcta-1", 4),
    mfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: [],
    ...opts.user,
  };
  const org = { settings: {}, deletedAt: null, ...(opts.org ?? {}) };
  const memberships = opts.membership === false ? [] : [{ organizationId: "o1", roleId: "r1", active: true }];
  const updates: Record<string, unknown>[] = [];
  const refrescos: string[] = [];

  const admin: any = {
    user: {
      findUnique: async () => ({ ...user, memberships }),
      update: async ({ data }: any) => {
        updates.push(data);
        Object.assign(user, data);
        return user;
      },
    },
    role: { findUnique: async () => ({ id: "r1", code: "owner", permissions: ["*"] }) },
    organization: { findUnique: async () => org },
  };
  const prisma: any = { admin };
  const refreshSessions: any = {
    create: async (uid: string) => {
      refrescos.push(uid);
      return "refresh-token";
    },
  };
  const service = new AuthService(prisma, {} as any, refreshSessions, { capi: { add: async () => undefined } } as any);
  return { service, user, secret, updates, refrescos };
}

describe("§3.3 — reenrolar MFA exige contraseña + código vigente", () => {
  it("primer enrolamiento (sin MFA activo): no pide nada extra", async () => {
    const { service, updates } = makeAuth();
    const r = await service.beginMfaSetup("u1");
    expect(r.secret).toBeTruthy();
    expect(updates.some((u) => "mfaSecret" in u)).toBe(true);
  });

  it("con MFA activo y sin credenciales → 400 y NO cambia el secreto", async () => {
    const secret = generateTotpSecret();
    const { service, updates } = makeAuth({ user: { mfaEnabled: true, mfaSecret: encryptSecret(secret) } });
    await expect(service.beginMfaSetup("u1")).rejects.toBeInstanceOf(BadRequestException);
    expect(updates.length).toBe(0);
  });

  it("contraseña incorrecta → 401 y NO cambia el secreto (el agujero: bastaba la sesión)", async () => {
    const secret = generateTotpSecret();
    const { service, updates } = makeAuth({ user: { mfaEnabled: true, mfaSecret: encryptSecret(secret) } });
    await expect(
      service.beginMfaSetup("u1", { password: "clave-equivocada", code: codigoVigente(secret) }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updates.length).toBe(0);
  });

  it("código incorrecto (aun con la contraseña buena) → 401", async () => {
    const secret = generateTotpSecret();
    const { service, updates } = makeAuth({ user: { mfaEnabled: true, mfaSecret: encryptSecret(secret) } });
    await expect(
      service.beginMfaSetup("u1", { password: "clave-correcta-1", code: "000000" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updates.length).toBe(0);
  });

  it("contraseña + TOTP vigente → entrega secreto nuevo", async () => {
    const secret = generateTotpSecret();
    const { service } = makeAuth({ user: { mfaEnabled: true, mfaSecret: encryptSecret(secret) } });
    const r = await service.beginMfaSetup("u1", { password: "clave-correcta-1", code: codigoVigente(secret) });
    expect(r.secret).toBeTruthy();
    expect(r.secret).not.toBe(secret);
  });

  it("contraseña + código de RECUPERACIÓN: sirve y se CONSUME (un solo uso)", async () => {
    const secret = generateTotpSecret();
    const [recovery, otro] = generateRecoveryCodes(2);
    const { service, updates } = makeAuth({
      user: { mfaEnabled: true, mfaSecret: encryptSecret(secret), mfaRecoveryCodes: [recovery, otro].map(hashRecoveryCode) },
    });
    const r = await service.beginMfaSetup("u1", { password: "clave-correcta-1", code: recovery });
    expect(r.secret).toBeTruthy();
    const consumo = updates.find((u) => "mfaRecoveryCodes" in u);
    expect(consumo).toBeTruthy();
    expect((consumo!.mfaRecoveryCodes as string[]).length).toBe(1);
  });
});

describe("§3.4 — Google no salta el segundo factor", () => {
  it("con MFA activo devuelve DESAFÍO, no sesión", async () => {
    const { service, refrescos } = makeAuth({ user: { mfaEnabled: true, mfaSecret: encryptSecret(generateTotpSecret()) } });
    const r: any = await service.loginWithGoogle("d@x.cl", "tubot");
    expect(r.mfaRequired).toBe(true);
    expect(r.mfaToken).toBeTruthy();
    expect(r.token).toBeUndefined(); // no hay sesión todavía
    expect(refrescos.length).toBe(0);
  });

  it("si la org exige MFA a admins y no está enrolado → fuerza el enrolamiento", async () => {
    const { service } = makeAuth({ org: { settings: { security: { requireMfaForAdmins: true } } } });
    const r: any = await service.loginWithGoogle("d@x.cl", "tubot");
    expect(r.mfaSetupRequired).toBe(true);
    expect(r.token).toBeUndefined();
  });

  it("sin MFA y sin política: entra normal, y tubot no recibe refresh (§10.2)", async () => {
    const { service, refrescos } = makeAuth();
    const r: any = await service.loginWithGoogle("d@x.cl", "tubot");
    expect(r.token).toBeTruthy();
    expect(r.refreshToken).toBeUndefined();
    expect(refrescos.length).toBe(0);
  });

  it("conversia sí recibe refresh", async () => {
    const { service, refrescos } = makeAuth({ user: { brand: "conversia" } });
    const r: any = await service.loginWithGoogle("d@x.cl", "conversia");
    expect(r.refreshToken).toBe("refresh-token");
    expect(refrescos).toEqual(["u1"]);
  });

  it("organización dada de baja → no entra ni con Google", async () => {
    const { service } = makeAuth({ org: { deletedAt: new Date() } });
    await expect(service.loginWithGoogle("d@x.cl", "tubot")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("§3.9 — el login revisa que la organización siga viva", () => {
  it("org borrada → 401 antes de cualquier desafío", async () => {
    const { service } = makeAuth({ org: { deletedAt: new Date() } });
    await expect(service.login({ email: "d@x.cl", password: "clave-correcta-1", brand: "tubot" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("org borrada: tampoco se emite el desafío de MFA (no se pide el 2.º factor de una cuenta muerta)", async () => {
    const { service } = makeAuth({
      user: { mfaEnabled: true, mfaSecret: encryptSecret(generateTotpSecret()) },
      org: { deletedAt: new Date() },
    });
    await expect(service.login({ email: "d@x.cl", password: "clave-correcta-1", brand: "tubot" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("org viva: login normal, y la cabecera sliding fuerza el refresh en tubot", async () => {
    const { service, refrescos } = makeAuth();
    const sin: any = await service.login({ email: "d@x.cl", password: "clave-correcta-1", brand: "tubot" });
    expect(sin.token).toBeTruthy();
    expect(sin.refreshToken).toBeUndefined();

    const con: any = await service.login({ email: "d@x.cl", password: "clave-correcta-1", brand: "tubot", sessionMode: "sliding" });
    expect(con.refreshToken).toBe("refresh-token");
    expect(refrescos.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 — permisos faltantes en la Bandeja
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.5 — un rol de solo lectura no puede operar la Bandeja", () => {
  const soloLectura = (): RequestContext => ({ userId: "u1", organizationId: "o1", roleCode: "viewer", permissions: ["inbox:read"] });

  // Se construye el controlador con un prisma que EXPLOTA si lo tocan: el permiso tiene
  // que cortar antes de llegar a la base. Si alguna vez no corta, el test falla por el throw.
  function controller() {
    const prisma: any = {
      withTenant: () => {
        throw new Error("no debería llegar a la base: el permiso tenía que cortar antes");
      },
      admin: {},
    };
    return new ConversationsController(prisma, {} as any, {} as any);
  }

  const casos: Array<[string, (c: any) => unknown]> = [
    ["enviar un mensaje", (c) => c.send("cv1", { body: "hola" })],
    ["cerrar la conversación", (c) => c.close("cv1", {})],
    ["reasignar", (c) => c.assign("cv1", { userId: "u2" })],
    ["mandar una plantilla", (c) => c.sendTemplate("cv1", { templateId: "t1" })],
    ["tomar el control", (c) => c.takeover("cv1")],
    ["devolver a la IA", (c) => c.release("cv1")],
    ["ejecutar un workflow", (c) => c.runWorkflow("cv1", { workflowId: "w1" })],
    ["mandar un evento CAPI", (c) => c.sendCapi("cv1", { event: "Lead" })],
    ["iniciar una conversación nueva", (c) => c.start({ phone: "+56900000000" })],
  ];

  for (const [nombre, accion] of casos) {
    it(`${nombre} → 403 sin inbox:write`, async () => {
      const c = controller();
      await expect(Promise.resolve().then(() => runWithContext(soloLectura(), () => accion(c)))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  }

  it("exportar conversaciones y leads exige reports:read (el rol operador no lo tiene)", async () => {
    const prisma: any = {
      withTenant: () => {
        throw new Error("no debería llegar a la base");
      },
    };
    const c = new ReportsController(prisma);
    const operador: RequestContext = {
      userId: "u1",
      organizationId: "o1",
      roleCode: "operator",
      permissions: ["inbox:read", "inbox:write", "contacts:read"],
    };
    await expect(
      Promise.resolve().then(() => runWithContext(operador, () => c.exportConversations({} as any))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      Promise.resolve().then(() => runWithContext(operador, () => c.exportLeads({} as any))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("elegir el agente de IA de la conversación exige agents:write (supervisor solo tiene agents:read)", async () => {
    const c = controller();
    const supervisor: RequestContext = {
      userId: "u1",
      organizationId: "o1",
      roleCode: "supervisor",
      permissions: ["inbox:*", "agents:read", "reports:read"],
    };
    await expect(
      Promise.resolve().then(() => runWithContext(supervisor, () => c.setAgent("cv1", { agentId: "ag1" }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.9 — desactivar o cambiar de rol corta las sesiones abiertas
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.9 — desactivar o cambiar el rol revoca las sesiones del usuario", () => {
  function setup() {
    const revocados: string[] = [];
    const tx: any = {
      organizationUser: {
        findFirst: async () => ({ id: "m1", userId: "u9", organizationId: "o1", roleId: "r-viejo" }),
        update: async ({ data }: any) => ({ id: "m1", ...data }),
      },
      role: {
        findUnique: async ({ where }: any) =>
          where.organizationId_code ? { id: `r-${where.organizationId_code.code}` } : { id: "r-viejo", code: "viewer" },
      },
    };
    const prisma: any = { withTenant: (_o: string, fn: any) => fn(tx), admin: {} };
    const auth: any = { revokeAllSessions: async (uid: string) => void revocados.push(uid) };
    const ctx: RequestContext = { userId: "u1", organizationId: "o1", roleCode: "owner", permissions: ["*"] };
    return { controller: new UsersController(prisma, auth), revocados, ctx };
  }

  it("desactivar al miembro revoca sus sesiones", async () => {
    const { controller, revocados, ctx } = setup();
    await runWithContext(ctx, () => controller.update("m1", { active: false }));
    expect(revocados).toEqual(["u9"]);
  });

  it("cambiarle el rol también (el token viejo llevaba los permisos viejos dentro)", async () => {
    const { controller, revocados, ctx } = setup();
    await runWithContext(ctx, () => controller.update("m1", { roleCode: "admin" }));
    expect(revocados).toEqual(["u9"]);
  });

  it("reactivarlo, o asignarle el MISMO rol, no revoca nada", async () => {
    const { controller, revocados, ctx } = setup();
    await runWithContext(ctx, () => controller.update("m1", { active: true }));
    await runWithContext(ctx, () => controller.update("m1", { roleCode: "viejo" }));
    expect(revocados).toEqual([]);
  });

  it("si la revocación falla, el cambio de rol NO se cae", async () => {
    const { controller, ctx } = setup();
    (controller as unknown as { auth: { revokeAllSessions: () => Promise<void> } }).auth.revokeAllSessions = async () => {
      throw new Error("Redis caído");
    };
    await expect(runWithContext(ctx, () => controller.update("m1", { active: false }))).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.10 — las rutas de invitación son públicas (el frontend las llama sin Bearer)
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.10 — el link de invitación no exige sesión", () => {
  const mw = new TenancyMiddleware();
  const pasa = (url: string) => {
    let llamado = false;
    mw.use(req({ originalUrl: url, headers: {} } as any), {} as any, () => {
      llamado = true;
    });
    return llamado;
  };

  it("ver la invitación y aceptarla pasan sin token", () => {
    // El frontend las tiene en AUTH_API_PATHS (apps/web/src/lib/api.ts): no manda Bearer
    // porque el invitado todavía no tiene cuenta. Antes el middleware cortaba acá.
    expect(pasa("/auth/invite/abc123")).toBe(true);
    expect(pasa("/auth/accept-invite")).toBe(true);
  });

  it("el resto de la app sigue exigiendo token", () => {
    expect(() => pasa("/conversations")).toThrowError(UnauthorizedException);
    expect(() => pasa("/users")).toThrowError(UnauthorizedException);
  });

  it("una ruta que solo EMPIECE parecido no se cuela", () => {
    expect(() => pasa("/invitaciones")).toThrowError(UnauthorizedException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 — las acciones de cuenta, negadas desde el controlador
// ─────────────────────────────────────────────────────────────────────────────
describe("§3.2 — el super admin impersonando no se apropia de la cuenta", () => {
  const prisma: any = {
    admin: { user: { findUnique: async () => null, update: async () => null } },
    withTenant: (_o: string, fn: any) => fn({ auditLog: { create: async () => null } }),
  };
  const controller = () => new AuthController({} as any, prisma, {} as any);
  const impersonado: RequestContext = {
    userId: "u1",
    organizationId: "o1",
    roleCode: "owner",
    permissions: ["*"],
    impersonatedBy: "sa_1",
  };

  it("no puede cambiar la contraseña", async () => {
    const c = controller();
    await expect(
      Promise.resolve().then(() => runWithContext(impersonado, () => c.changePassword({ current: "a", next: "abcdefgh1" }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("no puede cambiarse de organización", async () => {
    const c = controller();
    await expect(
      Promise.resolve().then(() => runWithContext(impersonado, () => c.switch({ organizationId: "o2" }, req()))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("no puede editar el perfil", async () => {
    const c = controller();
    await expect(
      Promise.resolve().then(() => runWithContext(impersonado, () => c.updateMe({ name: "Otro Nombre" }))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("no puede tocar el 2.º factor (el token `imp` se detecta en el Bearer)", async () => {
    const c = controller();
    const bearer = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"] }, { extra: { imp: "sa_1" } });
    const r = req({ headers: { authorization: `Bearer ${bearer}` } });
    await expect(c.mfaSetup(r, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.mfaDisable(r, { code: "123456" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.mfaEnable(r, { code: "123456" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("con una sesión NORMAL esas mismas rutas no se bloquean por este motivo", async () => {
    const c = controller();
    const normal: RequestContext = { ...impersonado, impersonatedBy: undefined };
    // Falla por otra razón (el usuario de prueba no existe en el prisma falso), no por 403.
    await expect(
      Promise.resolve().then(() => runWithContext(normal, () => c.changePassword({ current: "a", next: "abcdefgh1" }))),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });
});
