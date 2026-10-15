import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { getEnv } from "@conversia/config";
import { createAIRouter, fetchWebPageText } from "@conversia/agents";
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

  // ============================ V2-3 — GENERADOR /crear ============================
  // Producto en la portada: el visitante crea su bot (rubro + nombre + web/IG opcional),
  // lo PRUEBA en un simulador, y se registra para GUARDARLO. Sin cuenta. Draft efímero (72h).

  private ipHash(req: Request): string {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    return createHash("sha256").update(ip).digest("hex").slice(0, 32);
  }

  /** Resuelve el paquete vertical activo (mayor versión) para un rubro. */
  private async resolveVertical(key: string) {
    const rows = await this.prisma.admin.verticalTemplate.findMany({ where: { key, active: true }, orderBy: { version: "desc" }, take: 1 });
    return rows[0] ?? null;
  }

  /** Arma la config del draft (prompt del rubro + datos del negocio + servicios leídos/demo). */
  private buildDraftConfig(vertical: any, businessName: string, scrape: { text?: string } | null) {
    const def = (vertical?.definition ?? {}) as Record<string, any>;
    const agent = Array.isArray(def.agents) && def.agents.length ? def.agents[0] : {};
    const demoServices = Array.isArray(def.services) ? def.services : Array.isArray(def.catalog) ? def.catalog : [];
    return {
      vertical: vertical?.key ?? "generico",
      verticalName: vertical?.name ?? "Negocio",
      businessName,
      systemPrompt: typeof agent.systemPrompt === "string" ? agent.systemPrompt : "Eres la recepción del negocio. Atiendes por WhatsApp de forma cálida y breve; agendas y resuelves dudas con la info disponible; nunca inventes precios ni horarios.",
      scrapedText: scrape?.text ? scrape.text.slice(0, 2000) : null,
      demoServices,
    };
  }

  @Post("crear/draft")
  async crearDraft(@Body() body: unknown, @Req() req: Request) {
    const parsed = z
      .object({ vertical: z.string().min(1).max(60), businessName: z.string().min(2).max(120), website: z.string().max(300).optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Elige un rubro y el nombre de tu negocio.");
    const ipHash = this.ipHash(req);
    // Antiabuso: máx 3 drafts por IP por hora (el 4.º pide esperar).
    const rl = await this.rateLimit.custom(`rl:draft:${ipHash}`, 3, 3600);
    if (!rl.allowed) throw new HttpException("Creaste varios asistentes de prueba. Intenta de nuevo en un rato.", HttpStatus.TOO_MANY_REQUESTS);

    const vertical = await this.resolveVertical(parsed.data.vertical);
    // Scrape best-effort si dieron web/IG (leerWeb): servicios/precios/horarios o demo del paquete.
    let scrape: { text?: string } | null = null;
    if (parsed.data.website) {
      const r = await fetchWebPageText(parsed.data.website).catch(() => null);
      if (r && (r as any).ok && (r as any).text) scrape = { text: String((r as any).text) };
    }
    const config = this.buildDraftConfig(vertical, parsed.data.businessName, scrape);
    const token = randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000);
    await this.prisma.admin.draftSession.create({
      data: { token, vertical: config.vertical, businessName: parsed.data.businessName, website: parsed.data.website ?? null, ...(scrape ? { scrape: scrape as object } : {}), config: config as object, ipHash, expiresAt },
    });
    // Pasos "narrados" reales para la construcción (el front los anima).
    const steps = [
      parsed.data.website ? `Leyendo ${parsed.data.website}…` : "Cargando tu rubro…",
      `Configurando tu asistente de ${config.verticalName}…`,
      "Preparando tu agenda…",
      "Listo: tu asistente ya puede atender.",
    ];
    return { token, businessName: parsed.data.businessName, verticalName: config.verticalName, scraped: !!scrape, steps };
  }

  @Get("crear/:token")
  async crearGet(@Param("token") token: string) {
    const d = await this.prisma.admin.draftSession.findUnique({ where: { token } });
    if (!d || d.expiresAt < new Date()) throw new BadRequestException("Este borrador expiró. Crea tu asistente de nuevo.");
    const cfg = (d.config ?? {}) as Record<string, any>;
    return { token: d.token, businessName: d.businessName, verticalName: cfg.verticalName ?? "Negocio", messagesUsed: d.messagesUsed, messagesLimit: 15, materialized: d.status === "materialized" };
  }

  @Post("crear/:token/simulate")
  async crearSimulate(@Param("token") token: string, @Body() body: unknown) {
    const parsed = z
      .object({ history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(30) })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Mensaje inválido");
    const d = await this.prisma.admin.draftSession.findUnique({ where: { token } });
    if (!d || d.expiresAt < new Date()) throw new BadRequestException("Este borrador expiró. Crea tu asistente de nuevo.");
    if (d.messagesUsed >= 15) return { reply: "Probaste bastante el asistente. Crea tu cuenta gratis para guardarlo y seguir conversando sin límite.", capped: true, messagesUsed: d.messagesUsed, messagesLimit: 15 };

    const cfg = (d.config ?? {}) as Record<string, any>;
    const servicesBlock = Array.isArray(cfg.demoServices) && cfg.demoServices.length
      ? `\n\nServicios de ejemplo (${cfg.businessName}):\n${cfg.demoServices.slice(0, 8).map((s: any) => `- ${s.name ?? s.nombre ?? s}${s.price || s.precio ? ` ($${s.price ?? s.precio})` : ""}`).join("\n")}`
      : "";
    const scrapedBlock = cfg.scrapedText ? `\n\nInformación leída del sitio del negocio:\n${cfg.scrapedText}` : "";
    const system = `${cfg.systemPrompt}\n\nEres el asistente de "${cfg.businessName}". Saluda con ese nombre. Esto es una DEMO: puedes cotizar y agendar una hora de ejemplo, pero no hay sistema real detrás. Sé breve (2-3 frases).${servicesBlock}${scrapedBlock}`;

    const env = getEnv();
    const ai = createAIRouter({ anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY });
    let reply = "Hola 👋 ¿en qué te puedo ayudar?";
    try {
      const resp = await ai.chat({
        model: env.AI_DEFAULT_MODEL || "gpt-4o-mini",
        system,
        messages: parsed.data.history.map((m) => ({ role: m.role, content: m.content })),
        tools: [],
        maxTokens: 300,
      });
      if (resp?.text) reply = resp.text;
    } catch {
      reply = "Ahora mismo no puedo responder la demo, pero al crear tu cuenta tu asistente quedará listo para atender.";
    }
    await this.prisma.admin.draftSession.update({ where: { token }, data: { messagesUsed: { increment: 1 } } });
    return { reply, messagesUsed: d.messagesUsed + 1, messagesLimit: 15, capped: d.messagesUsed + 1 >= 15 };
  }
}
