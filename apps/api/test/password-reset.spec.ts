import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import * as bcryptMod from "bcryptjs";
import { AuthService } from "../src/auth/auth.service";
import { passwordFingerprint, signPasswordResetToken, verifyPasswordResetToken, signAppToken } from "../src/auth/jwt";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

/**
 * §10.5 — Recuperación de contraseña autoservicio.
 *
 * Antes no existía: quien olvidaba su contraseña tenía que pedirle al equipo que la
 * restableciera a mano, lo que además significa que alguien más elige (y ve) una
 * contraseña provisional de ese cliente.
 *
 * Lo que se prueba acá son las tres propiedades que hacen que esto sea seguro:
 *  1. La respuesta de "pedir enlace" es UNIFORME: no se puede averiguar qué correos existen.
 *  2. El token es de UN SOLO USO y vale 1 hora, sin guardar nada en base ni en Redis.
 *  3. Al cambiar la contraseña se revocan TODAS las sesiones abiertas.
 */

function makeAuth(opts: { user?: { id: string; email: string; passwordHash: string } | null } = {}) {
  const user = opts.user === undefined ? { id: "u1", email: "d@x.cl", passwordHash: bcrypt.hashSync("vieja-12345", 4) } : opts.user;
  const correos: Array<{ to: string }> = [];
  const revocados: string[] = [];
  const updates: Array<Record<string, unknown>> = [];

  const admin: any = {
    user: {
      findUnique: async () => (user ? { ...user, memberships: [{ organizationId: "o1" }] } : null),
      update: async ({ data }: any) => {
        updates.push(data);
        if (user && typeof data.passwordHash === "string") user.passwordHash = data.passwordHash;
        return user;
      },
    },
    organization: { findUnique: async () => ({ brand: "conversia" }) },
  };
  const prisma: any = { admin };
  const refreshSessions: any = {
    create: async () => "r",
    revokeAllForUser: async (uid: string) => void revocados.push(uid),
  };
  const service = new AuthService(prisma, {} as any, refreshSessions, { capi: { add: async () => undefined } } as any);
  // El envío se intercepta: lo que importa acá es SI se manda, no el contenido del correo.
  (service as any).sendPasswordResetEmail = async (to: string) => {
    correos.push({ to });
    return true;
  };
  return { service, user, correos, revocados, updates };
}

describe("§10.5 — pedir el enlace no revela qué correos existen", () => {
  it("cuenta existente: responde ok y manda el correo", async () => {
    const { service, correos } = makeAuth();
    await expect(service.requestPasswordReset("d@x.cl", "conversia")).resolves.toEqual({ ok: true });
    expect(correos.length).toBe(1);
  });

  it("cuenta INEXISTENTE: responde EXACTAMENTE lo mismo, y no manda nada", async () => {
    const { service, correos } = makeAuth({ user: null });
    await expect(service.requestPasswordReset("nadie@x.cl", "conversia")).resolves.toEqual({ ok: true });
    expect(correos).toEqual([]);
  });

  it("usuario sin contraseña (invitado que nunca la fijó): misma respuesta, sin correo", async () => {
    const { service, correos } = makeAuth({ user: { id: "u2", email: "i@x.cl", passwordHash: "" } });
    await expect(service.requestPasswordReset("i@x.cl", "conversia")).resolves.toEqual({ ok: true });
    expect(correos).toEqual([]);
  });

  it("ni un fallo de base cambia la respuesta (sería otra forma de filtrar)", async () => {
    const { service } = makeAuth();
    (service as any).prisma.admin.user.findUnique = async () => {
      throw new Error("BD caída");
    };
    await expect(service.requestPasswordReset("d@x.cl", "conversia")).resolves.toEqual({ ok: true });
  });
});

describe("§10.5 — el token es de un solo uso", () => {
  it("con el token bueno, cambia la contraseña y revoca las sesiones", async () => {
    const { service, user, revocados, updates } = makeAuth();
    const token = signPasswordResetToken(user!.id, passwordFingerprint(user!.passwordHash));
    await expect(service.resetPassword(token, "nueva-contrasena-1")).resolves.toEqual({ ok: true });
    expect(updates.length).toBe(1);
    // Se revocan TODAS las sesiones: si alguien entró con la contraseña vieja —el motivo
    // más probable de estar recuperando el acceso— queda fuera.
    expect(revocados).toEqual([user!.id]);
    expect(bcrypt.compareSync("nueva-contrasena-1", user!.passwordHash)).toBe(true);
  });

  it("el MISMO token no sirve dos veces", async () => {
    const { service, user } = makeAuth();
    const token = signPasswordResetToken(user!.id, passwordFingerprint(user!.passwordHash));
    await service.resetPassword(token, "nueva-contrasena-1");
    // La huella ya no calza con la contraseña nueva → el enlace murió, sin guardar estado.
    await expect(service.resetPassword(token, "otra-contrasena-9")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("un enlace pedido ANTES tampoco sirve después de usar otro", async () => {
    const { service, user } = memo(makeAuth());
    const viejo = signPasswordResetToken(user!.id, passwordFingerprint(user!.passwordHash));
    const nuevo = signPasswordResetToken(user!.id, passwordFingerprint(user!.passwordHash));
    await service.resetPassword(nuevo, "nueva-contrasena-1");
    await expect(service.resetPassword(viejo, "otra-contrasena-9")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("un token de OTRA audiencia (p. ej. de sesión) no sirve", async () => {
    const { service } = makeAuth();
    const sesion = signAppToken({ sub: "u1", orgId: "o1", role: "owner", perms: ["*"] });
    await expect(service.resetPassword(sesion, "nueva-contrasena-1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("basura o token recortado → 400 con mensaje accionable", async () => {
    const { service } = makeAuth();
    for (const malo of ["", "no-es-un-token", "a.b.c"]) {
      await expect(service.resetPassword(malo, "nueva-contrasena-1")).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("si la contraseña cambió por otra vía, el enlace pendiente deja de valer", async () => {
    const { service, user } = makeAuth();
    const token = signPasswordResetToken(user!.id, passwordFingerprint(user!.passwordHash));
    user!.passwordHash = bcrypt.hashSync("cambiada-desde-ajustes", 4); // el usuario la cambió él mismo
    await expect(service.resetPassword(token, "nueva-contrasena-1")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("§10.5 — el token de recuperación no sirve para entrar", () => {
  it("lleva su propia audiencia y propósito", () => {
    const token = signPasswordResetToken("u1", "huella");
    const claims = verifyPasswordResetToken(token);
    expect(claims).toEqual({ sub: "u1", pwd: "huella" });
  });

  it("la huella depende del hash: dos contraseñas distintas dan huellas distintas", () => {
    const a = passwordFingerprint(bcrypt.hashSync("una", 4));
    const b = passwordFingerprint(bcrypt.hashSync("otra", 4));
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
  });
});

/** Ayuda para el caso de los dos enlaces: deja claro que se usa el MISMO usuario. */
function memo<T>(x: T): T {
  return x;
}
