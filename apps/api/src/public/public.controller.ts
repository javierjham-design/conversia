import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

/**
 * API PÚBLICA de precios para la web (www.tubot.cl). Sin auth. Devuelve SÓLO
 * campos públicos de planes públicos y activos — nunca costos, márgenes, IDs
 * internos, overrides ni planes privados. La landing la consume (Fase E).
 */
@Controller("public")
export class PublicController {
  constructor(private prisma: PrismaService) {}

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
}
