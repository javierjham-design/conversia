import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as bcryptMod from "bcryptjs";
import { DEFAULT_LEAD_STATUSES, DEFAULT_ROLES } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { signAppToken, signMfaToken } from "./jwt";
import { encryptSecret, decryptSecret } from "../common/crypto";
import { consumeRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp } from "./totp";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;
/** Costo bcrypt (ASVS 2.4): 12 es el mínimo recomendado actual. */
export const BCRYPT_COST = 12;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  /**
   * Registro self-service: crea usuario + organización + roles del sistema +
   * estados de lead por defecto. Corre con la conexión admin (crear una
   * organización es una operación de plataforma, fuera del RLS del tenant).
   */
  async register(input: { email: string; password: string; name: string; organizationName: string }) {
    const db = this.prisma.admin;
    const existing = await db.user.findUnique({ where: { email: input.email } });
    // Anti-enumeración (ASVS 2.2 / OWASP): mensaje genérico + rate limit en el
    // controlador. No confirmamos si el correo ya existe.
    if (existing) throw new ConflictException("No se pudo completar el registro con esos datos");

    let slug = slugify(input.organizationName) || "organizacion";
    if (await db.organization.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }

    const result = await db.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: input.organizationName, slug },
      });
      // Habilita las políticas RLS para los inserts hijos de esta transacción.
      // (El INSERT en organizations requiere rol admin — ver docs/MULTITENANCY.md.)
      await tx.$queryRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
      const roles = await Promise.all(
        DEFAULT_ROLES.map((r) =>
          tx.role.create({
            data: {
              organizationId: org.id,
              code: r.code,
              name: r.name,
              permissions: [...r.permissions],
              system: true,
            },
          }),
        ),
      );
      const ownerRole = roles.find((r) => r.code === "owner")!;
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: bcrypt.hashSync(input.password, BCRYPT_COST),
          name: input.name,
        },
      });
      await tx.organizationUser.create({
        data: { organizationId: org.id, userId: user.id, roleId: ownerRole.id },
      });
      await tx.leadStatus.createMany({
        data: DEFAULT_LEAD_STATUSES.map((s) => ({
          organizationId: org.id,
          code: s.code,
          name: s.name,
          emoji: s.emoji,
          category: s.category as any,
          order: s.order,
          system: true,
        })),
      });
      await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorType: "user",
          actorId: user.id,
          action: "organization.create",
          entityType: "organization",
          entityId: org.id,
        },
      });
      return { org, user, role: ownerRole };
    });

    return this.issueTokens(result.user.id, result.org.id, result.role.code, ["*"]);
  }

  /**
   * Provisiona un DEMO: organización + usuario owner con IA PAUSADA
   * (aiKillSwitch) para que NO gaste tokens hasta que el super admin la habilite,
   * con vigencia limitada. Devuelve las credenciales (contraseña temporal una vez).
   */
  async provisionDemo(input: { email: string; name: string; company: string; demoDays?: number }) {
    const db = this.prisma.admin;
    let slug = slugify(input.company) || "demo";
    if (await db.organization.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const validUntil = new Date(Date.now() + (input.demoDays ?? 14) * 24 * 3600 * 1000).toISOString();
    const tempPassword = randomBytes(6).toString("base64url");
    return db.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.company,
          slug,
          // Demo: IA pausada (no gasta tokens) + tope 0 + vigencia, hasta habilitar.
          settings: { demo: true, aiKillSwitch: true, validUntil, limits: { aiTokensDaily: 0 } },
        },
      });
      await tx.$queryRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
      const roles = await Promise.all(
        DEFAULT_ROLES.map((r) =>
          tx.role.create({ data: { organizationId: org.id, code: r.code, name: r.name, permissions: [...r.permissions], system: true } }),
        ),
      );
      const ownerRole = roles.find((r) => r.code === "owner")!;
      let user = await tx.user.findUnique({ where: { email: input.email } });
      let revealPassword: string | null = tempPassword;
      if (!user) {
        user = await tx.user.create({
          data: { email: input.email, passwordHash: bcrypt.hashSync(tempPassword, BCRYPT_COST), name: input.name },
        });
      } else {
        revealPassword = null; // ya tenía cuenta: usa su contraseña existente
      }
      await tx.organizationUser.create({ data: { organizationId: org.id, userId: user.id, roleId: ownerRole.id } });
      await tx.leadStatus.createMany({
        data: DEFAULT_LEAD_STATUSES.map((s) => ({ organizationId: org.id, code: s.code, name: s.name, emoji: s.emoji, category: s.category as any, order: s.order, system: true })),
      });
      return { organizationId: org.id, email: input.email, tempPassword: revealPassword, validUntil };
    });
  }

  /** Usuario administrador (owner, o primer miembro activo) de una organización. */
  private async orgAdminUser(orgId: string) {
    const memberships = await this.prisma.admin.organizationUser.findMany({
      where: { organizationId: orgId, active: true },
      include: { user: true },
    });
    if (!memberships.length) return null;
    const roles = await this.prisma.admin.role.findMany({ where: { organizationId: orgId } });
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const chosen = memberships.find((m) => roleById.get(m.roleId)?.code === "owner") ?? memberships[0];
    return chosen.user;
  }

  /** Restablece la contraseña del admin del tenant: genera una temporal y actualiza el hash. */
  async resetOrgAdminPassword(orgId: string): Promise<{ userId: string; email: string; tempPassword: string } | null> {
    const user = await this.orgAdminUser(orgId);
    if (!user) return null;
    const tempPassword = randomBytes(6).toString("base64url");
    await this.prisma.admin.user.update({ where: { id: user.id }, data: { passwordHash: bcrypt.hashSync(tempPassword, BCRYPT_COST) } });
    return { userId: user.id, email: user.email, tempPassword };
  }

  /** Cambia el correo del admin del tenant (valida unicidad global). */
  async setOrgAdminEmail(orgId: string, email: string): Promise<{ userId: string; email: string }> {
    const user = await this.orgAdminUser(orgId);
    if (!user) throw new BadRequestException("La organización no tiene usuarios activos");
    const existing = await this.prisma.admin.user.findUnique({ where: { email } });
    if (existing && existing.id !== user.id) throw new ConflictException("Ese correo ya está en uso");
    await this.prisma.admin.user.update({ where: { id: user.id }, data: { email } });
    return { userId: user.id, email };
  }

  async login(input: { email: string; password: string }) {
    const user = await this.prisma.admin.user.findUnique({
      where: { email: input.email },
      include: { memberships: { where: { active: true } } },
    });
    if (!user || !bcrypt.compareSync(input.password, user.passwordHash)) {
      throw new UnauthorizedException("Credenciales inválidas");
    }
    const membership = user.memberships[0];
    if (!membership) throw new UnauthorizedException("El usuario no pertenece a ninguna organización");

    // 2.º factor activo → desafío (no se emite sesión hasta verificar el código).
    if (user.mfaEnabled) {
      return { mfaRequired: true as const, mfaToken: signMfaToken(user.id, "verify") };
    }
    // La organización exige MFA a owner/admin y este no está enrolado → forzar enrolamiento.
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const roleCode = role?.code ?? "viewer";
    const org = await this.prisma.admin.organization.findUnique({ where: { id: membership.organizationId }, select: { settings: true } });
    if ((org?.settings as any)?.security?.requireMfaForAdmins === true && (roleCode === "owner" || roleCode === "admin")) {
      return { mfaSetupRequired: true as const, mfaToken: signMfaToken(user.id, "setup") };
    }
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    await this.touchLastLogin(user.id);
    return this.issueTokens(user.id, membership.organizationId, roleCode, perms);
  }

  /** Emite la sesión completa de un usuario ya validado (2.º factor o Google). */
  private async issueForUser(userId: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId }, include: { memberships: { where: { active: true } } } });
    const membership = user?.memberships[0];
    if (!user || !membership) throw new UnauthorizedException("Sesión inválida");
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    await this.touchLastLogin(user.id);
    return this.issueTokens(user.id, membership.organizationId, role?.code ?? "viewer", perms);
  }

  /** Verifica el 2.º factor (TOTP o código de recuperación) y emite la sesión. */
  async verifyMfaLogin(userId: string, code: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user?.mfaEnabled || !user.mfaSecret) throw new UnauthorizedException("MFA no está activo");
    if (verifyTotp(decryptSecret(user.mfaSecret), code)) return this.issueForUser(userId);
    const remaining = consumeRecoveryCode(code, (user.mfaRecoveryCodes as string[]) ?? []);
    if (remaining) {
      await this.prisma.admin.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: remaining } });
      return this.issueForUser(userId);
    }
    throw new UnauthorizedException("Código de verificación inválido");
  }

  /** Genera un secreto TOTP (aún NO activo) y devuelve el URI para el QR. */
  async beginMfaSetup(userId: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("Usuario inválido");
    const secret = generateTotpSecret();
    await this.prisma.admin.user.update({ where: { id: userId }, data: { mfaSecret: encryptSecret(secret) } });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /** Confirma el código y ACTIVA MFA; devuelve los códigos de recuperación (una vez) + sesión. */
  async enableMfa(userId: string, code: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user?.mfaSecret) throw new BadRequestException("Primero genera el código QR de configuración.");
    if (!verifyTotp(decryptSecret(user.mfaSecret), code)) throw new BadRequestException("El código no es correcto. Revisa la hora de tu teléfono e inténtalo de nuevo.");
    const recoveryCodes = generateRecoveryCodes(8);
    await this.prisma.admin.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) },
    });
    const session = await this.issueForUser(userId);
    return { recoveryCodes, ...session };
  }

  /** Desactiva MFA tras validar un código (TOTP o de recuperación). */
  async disableMfa(userId: string, code: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user?.mfaEnabled) return { ok: true };
    const totpOk = user.mfaSecret ? verifyTotp(decryptSecret(user.mfaSecret), code) : false;
    const recoveryOk = consumeRecoveryCode(code, (user.mfaRecoveryCodes as string[]) ?? []) !== null;
    if (!totpOk && !recoveryOk) throw new BadRequestException("Código incorrecto.");
    await this.prisma.admin.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [], mfaEnrolledAt: null } });
    return { ok: true };
  }

  /**
   * Login con Google: el email ya viene verificado (ID token validado con Google
   * en el controlador). Solo permitimos cuentas que YA existen como miembros —
   * no es auto-registro. Mensaje genérico para no filtrar qué correos existen.
   */
  async loginWithGoogle(email: string) {
    const user = await this.prisma.admin.user.findUnique({
      where: { email },
      include: { memberships: { where: { active: true } } },
    });
    const membership = user?.memberships[0];
    if (!user || !membership) {
      throw new UnauthorizedException("Tu cuenta de Google no está autorizada en la plataforma");
    }
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role!.permissions as string[]) : [];
    await this.touchLastLogin(user.id);
    return this.issueTokens(user.id, membership.organizationId, role?.code ?? "viewer", perms);
  }

  /** Organizaciones a las que pertenece el usuario (para el selector de tenant). */
  async listOrganizations(userId: string) {
    const memberships = await this.prisma.admin.organizationUser.findMany({ where: { userId, active: true } });
    if (!memberships.length) return [];
    const [orgs, roles] = await Promise.all([
      this.prisma.admin.organization.findMany({ where: { id: { in: memberships.map((m) => m.organizationId) }, deletedAt: null }, select: { id: true, name: true, slug: true, status: true } }),
      this.prisma.admin.role.findMany({ where: { id: { in: memberships.map((m) => m.roleId) } }, select: { id: true, code: true } }),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const roleById = new Map(roles.map((r) => [r.id, r.code]));
    return memberships
      .map((m) => {
        const org = orgById.get(m.organizationId);
        return org ? { id: org.id, name: org.name, slug: org.slug, status: org.status, roleCode: roleById.get(m.roleId) ?? "viewer" } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Cambia la organización activa: valida la membresía y emite un token nuevo. */
  async switchOrg(userId: string, organizationId: string) {
    const membership = await this.prisma.admin.organizationUser.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!membership || !membership.active) throw new UnauthorizedException("No perteneces a esa organización");
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { deletedAt: true } });
    if (!org || org.deletedAt) throw new UnauthorizedException("Organización no disponible");
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    return this.issueTokens(userId, organizationId, role?.code ?? "viewer", perms);
  }

  /** Marca la última conexión — best-effort, jamás bloquea el login. */
  private async touchLastLogin(userId: string) {
    try {
      await this.prisma.admin.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    } catch {
      /* ignore */
    }
  }

  private issueTokens(userId: string, orgId: string, roleCode: string, perms: string[]) {
    const token = signAppToken({ sub: userId, orgId, role: roleCode, perms });
    return { token, organizationId: orgId, role: roleCode };
  }
}
