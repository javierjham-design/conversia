import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcryptMod from "bcryptjs";
import { DEFAULT_LEAD_STATUSES, DEFAULT_ROLES } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { signAppToken } from "./jwt";

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
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role!.permissions as string[]) : [];
    return this.issueTokens(user.id, membership.organizationId, role?.code ?? "viewer", perms);
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
    return this.issueTokens(user.id, membership.organizationId, role?.code ?? "viewer", perms);
  }

  private issueTokens(userId: string, orgId: string, roleCode: string, perms: string[]) {
    const token = signAppToken({ sub: userId, orgId, role: roleCode, perms });
    return { token, organizationId: orgId, role: roleCode };
  }
}
