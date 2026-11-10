import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { requireContext } from "../tenancy/context";
import { RateLimitService } from "../common/rate-limit";
import { AssistantService, isWebOwner } from "./assistant.service";
import { AssistantThreadsService } from "./assistant-threads.service";
import { adjuntosSchema } from "./adjuntos";

/**
 * BLOQUE B — API del Asistente Conversia. GET /assistant/context alimenta la burbuja
 * (modo, checklist, saldo, último error); POST /assistant/message corre un turno del
 * agente con el contexto del cliente. El organizationId y el rol salen SIEMPRE del JWT.
 *
 * B2 (nov-2026) — el HILO lo manda el servidor. El historial que recibe el modelo se lee de
 * la base, no del cuerpo de la petición: antes el navegador decidía qué "recordaba" Convi.
 */
@Controller("assistant")
export class AssistantController {
  constructor(
    private assistant: AssistantService,
    private rateLimit: RateLimitService,
    private hilos: AssistantThreadsService,
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
    const c = await this.assistant.buildContext(ctx.organizationId, ctx.userId);
    return { ...c, canConfigure: isWebOwner(ctx.roleCode) };
  }

  @Post("message")
  async message(@Body() body: unknown) {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    const parsed = z
      .object({
        // Sin `min(1)`: un mensaje puede ser SOLO una nota de voz o una foto, y exigir
        // texto obligaba a escribir "mira esto" para poder mandar lo que importa.
        message: z.string().trim().max(2000),
        route: z.string().max(120).optional(),
        /**
         * B2 — se acepta y se IGNORA, por compatibilidad con el widget viejo (B3 lo quita).
         * El historial lo arma el servidor desde la base: si lo mandara el cliente, lo que
         * Convi "recuerda" sería lo que el navegador quiera decirle.
         */
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(20).optional(),
        /** Hilo donde continuar. Tiene que ser del mismo usuario y organización. */
        threadId: z.string().min(1).max(40).optional(),
        adjuntos: adjuntosSchema.optional(),
      })
      .refine((d) => d.message.length > 0 || (d.adjuntos?.length ?? 0) > 0, "Escribe algo o adjunta un archivo")
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Mensaje requerido");
    // Antiabuso: el asistente corre IA; acotamos a 20 turnos / 5 min por usuario.
    const rl = await this.rateLimit.custom(`rl:assistant:${ctx.userId ?? "anon"}`, 20, 300);
    if (!rl.allowed) throw new HttpException("Vas muy rápido. Espera unos segundos.", HttpStatus.TOO_MANY_REQUESTS);
    // Y un tope PROPIO para los adjuntos: transcribir audio y mirar imágenes cuesta varias
    // veces más que un turno de texto, así que 20 turnos con tres archivos cada uno no es
    // el mismo gasto que 20 turnos escritos.
    const adjuntos = parsed.data.adjuntos ?? [];
    if (adjuntos.length) {
      const rlAdj = await this.rateLimit.custom(`rl:assistant:adj:${ctx.userId ?? "anon"}`, 12, 300);
      if (!rlAdj.allowed) throw new HttpException("Vamos muy rápido con los archivos. Espera un momento.", HttpStatus.TOO_MANY_REQUESTS);
    }

    const hilo = await this.hilos.hiloParaEscribir(ctx.organizationId, ctx.userId ?? "", parsed.data.threadId);
    const history = await this.hilos.historialParaElPrompt(ctx.organizationId, hilo.id);
    const r = await this.assistant.run(
      { organizationId: ctx.organizationId, userId: ctx.userId, role: ctx.roleCode },
      parsed.data.message,
      history,
      parsed.data.route,
      adjuntos,
      hilo.summary,
    );
    // Guardar NUNCA puede costarle la respuesta al dueño: si la base falla, ya la tiene.
    await this.hilos.guardarTurno({
      organizationId: ctx.organizationId,
      threadId: hilo.id,
      userMessage: parsed.data.message,
      reply: r.reply,
      route: parsed.data.route,
      actions: r.actions,
      adjuntos: adjuntos.map((a) => ({ tipo: a.tipo, nombre: a.nombre })),
    });
    // El resumen se recalcula DESPUÉS de responder (no hace esperar al dueño).
    void this.hilos.resumirSiHaceFalta(ctx.organizationId, hilo.id);
    return { ...r, threadId: hilo.id };
  }

  // ─────────────────────────── Historial (B2) ───────────────────────────

  /** Los hilos del usuario. Un administrador ve los de toda su organización. */
  @Get("threads")
  async threads(@Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    const q = z.object({ cursor: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).safeParse({ cursor, limit });
    if (!q.success) throw new BadRequestException("Parámetros inválidos");
    return this.hilos.listar(ctx.organizationId, ctx.userId ?? "", {
      esAdmin: isWebOwner(ctx.roleCode),
      limite: q.data.limit,
      antesDe: q.data.cursor ? new Date(q.data.cursor) : undefined,
    });
  }

  @Get("threads/:id/messages")
  async threadMessages(@Param("id") id: string, @Query("cursor") cursor?: string) {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    const q = z.object({ cursor: z.string().datetime().optional() }).safeParse({ cursor });
    if (!q.success) throw new BadRequestException("Cursor inválido");
    return this.hilos.mensajes(ctx.organizationId, ctx.userId ?? "", id, {
      esAdmin: isWebOwner(ctx.roleCode),
      cursor: q.data.cursor ? new Date(q.data.cursor) : undefined,
    });
  }

  /** "Nueva conversación": archiva la abierta y abre otra. */
  @Post("threads/new")
  async newThread() {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    return this.hilos.nuevoHilo(ctx.organizationId, ctx.userId ?? "");
  }

  @Patch("threads/:id")
  async patchThread(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    await this.assertConversia(ctx.organizationId);
    const p = z.object({ title: z.string().trim().max(80).optional(), status: z.enum(["open", "archived"]).optional() }).safeParse(body);
    if (!p.success || (p.data.title === undefined && p.data.status === undefined)) throw new BadRequestException("Nada que cambiar");
    return this.hilos.actualizar(ctx.organizationId, ctx.userId ?? "", id, p.data, isWebOwner(ctx.roleCode));
  }
}
