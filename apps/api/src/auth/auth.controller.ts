import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { AuthService } from "./auth.service";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Mínimo 8 caracteres"),
  name: z.string().min(2),
  organizationName: z.string().min(2),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

@Controller("auth")
export class AuthController {
  constructor(
    private auth: AuthService,
    private prisma: PrismaService,
  ) {}

  @Post("register")
  register(@Body() body: unknown) {
    return this.auth.register(parse(registerSchema, body));
  }

  @Post("login")
  login(@Body() body: unknown) {
    return this.auth.login(parse(loginSchema, body));
  }

  @Get("me")
  async me() {
    const ctx = requireContext();
    const [user, org] = await Promise.all([
      this.prisma.admin.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, email: true, name: true },
      }),
      this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.organization.findUnique({
          where: { id: ctx.organizationId },
          select: { id: true, name: true, slug: true, timezone: true, currency: true },
        }),
      ),
    ]);
    return { user, organization: org, role: ctx.roleCode, permissions: ctx.permissions };
  }
}
