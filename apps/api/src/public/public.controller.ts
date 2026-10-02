import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";

/**
 * API PÚBLICA para la web (www.tubot.cl). Sin auth. Precios públicos + captura de
 * solicitudes de demo (CRM de prospectos). Nunca expone datos internos.
 */
@Controller("public")
export class PublicController {
  constructor(
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
  ) {}

  @Get("plans")
  async plans() {
    const plans = await this.prisma.admin.plan.findMany({
      where: { isPublic: true, active: true },
      orderBy: { order: "asc" },
    });
    return plans.map((p) => ({
      code: p.code,
      name: p.name,
      priceClp: Number(p.priceClp),
      priceUsd: Number(p.priceUsd),
      interval: p.interval,
      order: p.order,
      limits: (p.limits ?? {}) as Record<string, number>,
      features: (p.features ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * Rubros disponibles en el REGISTRO público (catálogo CONVERSIA_RUBROS.md): SOLO los
   * de ola 1 con status active. El Super Admin activa los demás por dato (wave/status),
   * sin deploy, y aquí aparecen solos. Devuelve la mayor versión activa por key.
   */
  @Get("verticals")
  async verticals() {
    const rows = await this.prisma.admin.verticalTemplate.findMany({
      where: { active: true, status: "active", wave: 1 },
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });
    const seen = new Set<string>();
    const out: { key: string; name: string; emoji: string; tagline: string; variant: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.key)) continue; // nos quedamos con la mayor versión (orderBy desc)
      seen.add(r.key);
      const ui = (((r.definition ?? {}) as Record<string, any>).ui ?? {}) as { emoji?: string; tagline?: string };
      out.push({ key: r.key, name: r.name, emoji: ui.emoji ?? "✨", tagline: ui.tagline ?? "", variant: r.variant });
    }
    return out;
  }

  /** Solicitud de demo desde la web ("Empezar"/"Solicitar demo"). Rate-limited. */
  @Post("demo-request")
  async demoRequest(@Body() body: unknown) {
    const parsed = z
      .object({
        name: z.string().min(2).max(80),
        email: z.string().email().max(200),
        company: z.string().max(120).optional(),
        phone: z.string().max(40).optional(),
        planInterest: z.string().max(40).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Revisa los datos: nombre y email válidos son obligatorios.");
    const rl = await this.rateLimit.custom(`rl:demo:${parsed.data.email.toLowerCase()}`, 5, 3600);
    if (!rl.allowed) throw new HttpException("Demasiadas solicitudes. Intenta más tarde.", HttpStatus.TOO_MANY_REQUESTS);
    await this.prisma.admin.demoLead.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        company: parsed.data.company,
        phone: parsed.data.phone,
        planInterest: parsed.data.planInterest,
        status: "NEW",
      },
    });
    return { ok: true };
  }
}
