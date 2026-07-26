import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";
import { requireContext } from "../tenancy/context";
import { AuthService } from "./auth.service";

const registerSchema = z.object({
  email: z.string().email().max(200),
  // Política por longitud (ASVS 2.1): mínimo 10, sin tope agresivo (permite passphrases)
  password: z.string().min(10, "La contraseña debe tener al menos 10 caracteres").max(200),
  name: z.string().min(2).max(80),
  organizationName: z.string().min(2).max(120),
});

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
}

@Controller("auth")
export class AuthController {
  constructor(
    private auth: AuthService,
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
  ) {}

  @Post("register")
  async register(@Body() body: unknown, @Req() req: Request) {
    const input = parse(registerSchema, body);
    const rl = await this.rateLimit.register(clientIp(req));
    if (!rl.allowed) {
      throw new HttpException("Demasiados registros desde este origen. Intenta más tarde.", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.auth.register(input);
  }

  @Post("login")
  async login(@Body() body: unknown) {
    const input = parse(loginSchema, body);
    // Límite por EMAIL (credencial atacada, no spoofeable) — anti credential stuffing
    const rl = await this.rateLimit.login(input.email);
    if (!rl.allowed) {
      throw new HttpException(
        "Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.auth.login(input);
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
