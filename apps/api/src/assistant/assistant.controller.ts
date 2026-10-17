import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, NotFoundException, Post } from "@nestjs/common";
import { z } from "zod";
import type { AIChatMessage } from "@conversia/types";
import { requireContext } from "../tenancy/context";
import { RateLimitService } from "../common/rate-limit";
import { AssistantService, isWebOwner } from "./assistant.service";

/**
 * BLOQUE B — API del Asistente Conversia. GET /assistant/context alimenta la burbuja
 * (modo, checklist, saldo, último error); POST /assistant/message corre un turno del
 * agente con el contexto del cliente. El organizationId y el rol salen SIEMPRE del JWT.
 */
@Controller("assistant")
export class AssistantController {
  constructor(
    private assistant: AssistantService,
    private rateLimit: RateLimitService,
  ) {}

  /**
   * El Asistente Conversia es exclusivo de la 2.ª marca: si una org de otra marca (p. ej.
   * TuBot) llega aquí, respondemos 404 (su panel ni siquiera lo expone). Evita que un
   * owner de TuBot reciba un asistente con copy de Conversia sobre su propia org.
   */
  private async assertConversia(organizationId: string) {
    if ((await this.assistant.orgBrand(organizationId)) !== "conversia") throw new NotFoundException();
  }

  @Get("context")
  async context() {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    const c = await this.assistant.buildContext(ctx.organizationId);
    return { ...c, canConfigure: isWebOwner(ctx.roleCode) };
  }

  @Post("message")
  async message(@Body() body: unknown) {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    const parsed = z
      .object({
        message: z.string().trim().min(1).max(2000),
        route: z.string().max(120).optional(),
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(20).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Mensaje requerido");
    // Antiabuso: el asistente corre IA; acotamos a 20 turnos / 5 min por usuario.
    const rl = await this.rateLimit.custom(`rl:assistant:${ctx.userId ?? "anon"}`, 20, 300);
    if (!rl.allowed) throw new HttpException("Vas muy rápido. Espera unos segundos.", HttpStatus.TOO_MANY_REQUESTS);
    const history = (parsed.data.history ?? []) as AIChatMessage[];
    const r = await this.assistant.run({ organizationId: ctx.organizationId, userId: ctx.userId, role: ctx.roleCode }, parsed.data.message, history, parsed.data.route);
    return r;
  }
}
