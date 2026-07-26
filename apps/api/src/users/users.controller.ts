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
import { PrismaService } from "../prisma.service";
import { enforcePlanLimit } from "../common/plan-limits";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

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
      tx.role.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true, permissions: true } }),
    );
  }

  @Get()
  list() {
    const ctx = requirePermission("users:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [members, roles, teams] = await Promise.all([
        tx.organizationUser.findMany({
          include: { user: { select: { id: true, email: true, name: true } } },
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
      return { ok: true, email: input.email, tempPassword };
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

  // ------------------------------ Equipos ------------------------------

  @Get("teams")
  teams() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const teams = await tx.team.findMany({ include: { members: true }, orderBy: { createdAt: "asc" } });
      const users = await tx.organizationUser.findMany({ include: { user: { select: { id: true, name: true } } } });
      const nameByUser = new Map(users.map((u) => [u.user.id, u.user.name]));
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
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
