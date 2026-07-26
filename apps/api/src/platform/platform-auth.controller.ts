import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import * as bcryptMod from "bcryptjs";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";
import { PlatformGuard, type PlatformRequest } from "./platform.guard";
import { signPlatformToken } from "./platform.jwt";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

@Controller("platform/auth")
export class PlatformAuthController {
  constructor(
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
  ) {}

  @Post("login")
  async login(@Body() body: unknown) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Credenciales inválidas");
    const rl = await this.rateLimit.custom(`rl:platform-login:${parsed.data.email.toLowerCase()}`, 15, 900);
    if (!rl.allowed) {
      throw new HttpException("Demasiados intentos. Espera unos minutos.", HttpStatus.TOO_MANY_REQUESTS);
    }
    const admin = await this.prisma.admin.platformAdmin.findUnique({ where: { email: parsed.data.email } });
    if (!admin || !bcrypt.compareSync(parsed.data.password, admin.passwordHash)) {
      throw new UnauthorizedException("Credenciales inválidas");
    }
    await this.prisma.admin.auditLog.create({
      data: { actorType: "platform_admin", actorId: admin.id, action: "platform.login", entityType: "platform_admin", entityId: admin.id },
    });
    return { token: signPlatformToken({ sub: admin.id, email: admin.email }), name: admin.name };
  }

  @Get("me")
  @UseGuards(PlatformGuard)
  me(@Req() req: PlatformRequest) {
    return { admin: req.platformAdmin };
  }
}
