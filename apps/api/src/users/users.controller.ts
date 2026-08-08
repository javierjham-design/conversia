import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as bcryptMod from "bcryptjs";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PERMISSION_CATALOG, isAssignablePermission } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { signInviteToken } from "../auth/jwt";
import { enforcePlanLimit } from "../common/plan-limits";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const RESERVED_ROLE_CODES = ["owner", "admin"];
const roleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_-]{1,29}$/, "Código inválido (minúsculas, sin espacios)"),
  name: z.string().min(2).max(40),
  permissions: z.array(z.string()).max(60),
});
const roleUpdateSchema = z.object({
  name: z.string().min(2).max(40).optional(),
  permissions: z.array(z.string()).max(60).optional(),
});

/** Deduplica y valida que todos los permisos existan en el catálogo. */
function sanitizePerms(perms: string[]): string[] {
  const deduped = Array.from(new Set(perms.map((p) => p.trim()).filter(Boolean)));
  const bad = deduped.filter((p) => !isAssignablePermission(p));
  if (bad.length) throw new BadRequestException(`Permisos no válidos: ${bad.join(", ")}`);
  return deduped;
}

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(60),
  roleCode: z.string().min(2),
});

const updateMemberSchema = z.object({
  roleCode: z.string().optional(),
  active: z.boolean().optional(),
});

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    email: z.string().trim().toLowerCase().email("Email inválido").optional(),
    phone: z.string().trim().max(32).nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.email !== undefined || b.phone !== undefined, "Nada que actualizar");

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  }
  return r.data;
}

@Controller("users")
export class UsersController {
  constructor(private prisma: PrismaService) {}

  /** Lista liviana para asignar conversaciones (cualquier rol con bandeja). */
  @Get("assignable")
  assignable() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const members = await tx.organizationUser.findMany({
        where: { active: true },
        include: { user: { select: { id: true, name: true } } },
      });
      return members.map((m) => ({ userId: m.user.id, name: m.user.name }));
    });
  }

  @Get("roles")
  roles() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.role.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true, permissions: true, system: true } }),
    );
  }

  /** Catálogo de permisos asignables (para la UI de roles). */
  @Get("permissions")
  permissionsCatalog() {
    requireContext();
    return PERMISSION_CATALOG;
  }

  /** Crea un rol personalizado con un subconjunto de permisos del catálogo. */
  @Post("roles")
  createRole(@Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(roleSchema, body);
    if (RESERVED_ROLE_CODES.includes(input.code)) throw new BadRequestException("Ese código está reservado");
    const perms = sanitizePerms(input.permissions);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.role.findUnique({
        where: { organizationId_code: { organizationId: ctx.organizationId, code: input.code } },
      });
      if (exists) throw new BadRequestException("Ya existe un rol con ese código");
      const role = await tx.role.create({
        data: { organizationId: ctx.organizationId, code: input.code, name: input.name, permissions: perms, system: false },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "role.create", entityType: "role", entityId: role.id, after: { code: input.code, permissions: perms } },
      });
      return { code: role.code, name: role.name, permissions: perms, system: false };
    });
  }

  /** Edita nombre/permisos de un rol. Los roles owner/admin (acceso total) no se editan. */
  @Patch("roles/:code")
  updateRole(@Param("code") code: string, @Body() body: unknown) {
    const ctx = requirePermission("users:write");
    if (RESERVED_ROLE_CODES.includes(code)) throw new BadRequestException("Los roles de administración no se editan");
    const input = parse(roleUpdateSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const role = await tx.role.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } } });
      if (!role) throw new NotFoundException("Rol no encontrado");
      const data: { name?: string; permissions?: string[] } = {};
      if (input.name) data.name = input.name;
      if (input.permissions) data.permissions = sanitizePerms(input.permissions);
      const updated = await tx.role.update({ where: { id: role.id }, data });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "role.update", entityType: "role", entityId: role.id, after: data },
      });
      return { code: updated.code, name: updated.name, permissions: updated.permissions, system: updated.system };
    });
  }

  /** Elimina un rol personalizado (no del sistema y sin usuarios asignados). */
  @Delete("roles/:code")
  deleteRole(@Param("code") code: string) {
    const ctx = requirePermission("users:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const role = await tx.role.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } } });
      if (!role) throw new NotFoundException("Rol no encontrado");
      if (role.system) throw new BadRequestException("No se puede eliminar un rol del sistema");
      const inUse = await tx.organizationUser.count({ where: { roleId: role.id } });
      if (inUse > 0) throw new BadRequestException("Hay usuarios con este rol. Reasígnalos antes de eliminarlo.");
      await tx.role.delete({ where: { id: role.id } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "role.delete", entityType: "role", entityId: role.id },
      });
      return { ok: true };
    });
  }

  @Get()
  list() {
    const ctx = requirePermission("users:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [members, roles, teams] = await Promise.all([
        tx.organizationUser.findMany({
          include: { user: { select: { id: true, email: true, name: true, phone: true, lastLoginAt: true } } },
          orderBy: { createdAt: "asc" },
        }),
        tx.role.findMany(),
        tx.team.findMany({ include: { members: true } }),
      ]);
      const roleById = new Map(roles.map((r) => [r.id, r]));
      return members.map((m) => ({
        membershipId: m.id,
        userId: m.user.id,
        email: m.user.email,
        name: m.user.name,
        phone: m.user.phone,
        lastLoginAt: m.user.lastLoginAt,
        active: m.active,
        roleCode: roleById.get(m.roleId)?.code ?? "?",
        roleName: roleById.get(m.roleId)?.name ?? "?",
        teams: teams.filter((t) => t.members.some((tm) => tm.userId === m.user.id)).map((t) => t.name),
      }));
    });
  }

  /**
   * Invita un usuario. Sin servicio de correo aún: si el usuario no existe se
   * genera una contraseña temporal que se muestra UNA vez al administrador.
   */
  @Post()
  invite(@Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(inviteSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await enforcePlanLimit(tx, "users", await tx.organizationUser.count({ where: { active: true } }));
      const role = await tx.role.findUnique({
        where: { organizationId_code: { organizationId: ctx.organizationId, code: input.roleCode } },
      });
      if (!role) throw new BadRequestException("Rol desconocido");

      // Usuario global: puede existir por pertenecer a otra organización
      let user = await this.prisma.admin.user.findUnique({ where: { email: input.email } });
      let tempPassword: string | null = null;
      if (!user) {
        tempPassword = randomBytes(6).toString("base64url");
        user = await this.prisma.admin.user.create({
          data: { email: input.email, name: input.name, passwordHash: bcrypt.hashSync(tempPassword, 10) },
        });
      }

      const existing = await tx.organizationUser.findUnique({
        where: { organizationId_userId: { organizationId: ctx.organizationId, userId: user.id } },
      });
      if (existing) throw new BadRequestException("Ese usuario ya pertenece a la organización");

      await tx.organizationUser.create({
        data: { organizationId: ctx.organizationId, userId: user.id, roleId: role.id },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "user.invite",
          entityType: "user",
          entityId: user.id,
          after: { email: input.email, role: input.roleCode },
        },
      });
      // Link copiable: el invitado abre /accept-invite y fija su contraseña (o,
      // si ya tenía cuenta, va al login). `fresh` = cuenta recién creada.
      const token = signInviteToken(user.id, tempPassword !== null);
      const inviteUrl = `${getEnv().WEB_URL.replace(/\/$/, "")}/accept-invite?token=${token}`;
      return { ok: true, email: input.email, tempPassword, inviteUrl };
    });
  }

  @Patch(":membershipId")
  update(@Param("membershipId") membershipId: string, @Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(updateMemberSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const member = await tx.organizationUser.findUnique({ where: { id: membershipId } });
      if (!member) throw new NotFoundException("Miembro no encontrado");
      if (member.userId === ctx.userId && input.active === false) {
        throw new BadRequestException("No puedes desactivar tu propia cuenta");
      }
      let roleId = member.roleId;
      if (input.roleCode) {
        const role = await tx.role.findUnique({
          where: { organizationId_code: { organizationId: ctx.organizationId, code: input.roleCode } },
        });
        if (!role) throw new BadRequestException("Rol desconocido");
        roleId = role.id;
      }
      return tx.organizationUser.update({
        where: { id: membershipId },
        data: { roleId, ...(input.active !== undefined ? { active: input.active } : {}) },
      });
    });
  }

  /**
   * Solo un propietario puede gestionar (editar/restablecer) la cuenta de otro
   * propietario — evita que un admin tome control de la cuenta dueña del tenant.
   */
  private async assertCanManage(tx: any, ctx: { organizationId: string; userId?: string | null }, targetRoleId: string) {
    const targetRole = await tx.role.findUnique({ where: { id: targetRoleId } });
    if (targetRole?.code !== "owner") return;
    const actor = ctx.userId
      ? await tx.organizationUser.findUnique({
          where: { organizationId_userId: { organizationId: ctx.organizationId, userId: ctx.userId } },
        })
      : null;
    const actorRole = actor ? await tx.role.findUnique({ where: { id: actor.roleId } }) : null;
    if (actorRole?.code !== "owner") {
      throw new BadRequestException("Solo un propietario puede gestionar la cuenta de otro propietario");
    }
  }

  /** Edita los datos del usuario (nombre, email, teléfono). */
  @Patch(":membershipId/profile")
  updateProfile(@Param("membershipId") membershipId: string, @Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(updateProfileSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const member = await tx.organizationUser.findUnique({ where: { id: membershipId } });
      if (!member) throw new NotFoundException("Miembro no encontrado");
      await this.assertCanManage(tx, ctx, member.roleId);

      if (input.email) {
        const existing = await this.prisma.admin.user.findUnique({ where: { email: input.email } });
        if (existing && existing.id !== member.userId) throw new BadRequestException("Ese email ya está en uso por otro usuario");
      }
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.email !== undefined) data.email = input.email;
      if (input.phone !== undefined) data.phone = input.phone || null;
      const user = await this.prisma.admin.user.update({
        where: { id: member.userId },
        data,
        select: { id: true, name: true, email: true, phone: true },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "user.profile_update",
          entityType: "user",
          entityId: member.userId,
          after: data as object,
        },
      });
      return { ok: true, ...user };
    });
  }

  /**
   * Restablece la contraseña: genera una temporal que se muestra UNA sola vez
   * al administrador (sin servicio de correo aún). Invalida la anterior.
   */
  @Post(":membershipId/reset-password")
  resetPassword(@Param("membershipId") membershipId: string) {
    const ctx = requirePermission("users:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const member = await tx.organizationUser.findUnique({
        where: { id: membershipId },
        include: { user: { select: { id: true, email: true } } },
      });
      if (!member) throw new NotFoundException("Miembro no encontrado");
      await this.assertCanManage(tx, ctx, member.roleId);

      const tempPassword = randomBytes(9).toString("base64url");
      await this.prisma.admin.user.update({
        where: { id: member.userId },
        data: { passwordHash: bcrypt.hashSync(tempPassword, 10) },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "user.password_reset",
          entityType: "user",
          entityId: member.userId,
          after: { email: member.user.email },
        },
      });
      return { ok: true, tempPassword };
    });
  }

  // ------------------------------ Equipos ------------------------------

  @Get("teams")
  teams() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const teams = await tx.team.findMany({ include: { members: true }, orderBy: { createdAt: "asc" } });
      const users = await tx.organizationUser.findMany({ include: { user: { select: { id: true, name: true } } } });
      const nameByUser = new Map(users.map((u) => [u.user.id, u.user.name]));
      const openByTeam = await tx.conversation.groupBy({
        by: ["assignedTeamId"],
        where: { status: { in: ["OPEN", "PENDING"] }, assignedTeamId: { not: null } },
        _count: { _all: true },
      });
      const openCount = new Map(openByTeam.map((r) => [r.assignedTeamId, r._count._all]));
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        openConversations: openCount.get(t.id) ?? 0,
        members: t.members.map((m) => ({ userId: m.userId, name: nameByUser.get(m.userId) ?? "?" })),
      }));
    });
  }

  @Post("teams")
  createTeam(@Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(z.object({ name: z.string().min(2).max(50), description: z.string().max(200).optional() }), body);
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.team.create({ data: { organizationId: ctx.organizationId, name: input.name, description: input.description } }),
    );
  }

  @Patch("teams/:teamId")
  updateTeam(@Param("teamId") teamId: string, @Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(z.object({ name: z.string().min(2).max(50).optional(), description: z.string().max(200).optional() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (!team) throw new NotFoundException("Equipo no encontrado");
      return tx.team.update({ where: { id: teamId }, data: input });
    });
  }

  /** Elimina un equipo: desasigna sus conversaciones (quedan sin equipo) y limpia miembros. */
  @Delete("teams/:teamId")
  deleteTeam(@Param("teamId") teamId: string) {
    const ctx = requirePermission("users:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (!team) throw new NotFoundException("Equipo no encontrado");
      const unassigned = await tx.conversation.updateMany({ where: { assignedTeamId: teamId }, data: { assignedTeamId: null } });
      await tx.teamMember.deleteMany({ where: { teamId } });
      await tx.team.delete({ where: { id: teamId } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "team.delete", entityType: "team", entityId: teamId, after: { name: team.name, unassignedConversations: unassigned.count } },
      });
      return { ok: true, unassigned: unassigned.count };
    });
  }

  @Post("teams/:teamId/members")
  addTeamMember(@Param("teamId") teamId: string, @Body() body: unknown) {
    const ctx = requirePermission("users:write");
    const input = parse(z.object({ userId: z.string() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (!team) throw new NotFoundException("Equipo no encontrado");
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId: input.userId } },
        update: {},
        create: { organizationId: ctx.organizationId, teamId, userId: input.userId },
      });
      return { ok: true };
    });
  }

  @Delete("teams/:teamId/members/:userId")
  removeTeamMember(@Param("teamId") teamId: string, @Param("userId") userId: string) {
    const ctx = requirePermission("users:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.teamMember.deleteMany({ where: { teamId, userId } });
      return { ok: true };
    });
  }
}
