import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { getEnv, brandFromOrigin } from "@conversia/config";
import { CREDITOS_POR_CONVERSACION_POR_DEFECTO, bonoDePacks, createAIRouter, fetchWebPageText } from "@conversia/agents";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";
import { INDUSTRIES } from "../common/industries";
import { packUnitForBrand } from "../billing/pack-unit";

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
  async plans(@Query("brand") brand?: string) {
    // Precios SIEMPRE acotados por marca (default tubot = comportamiento previo de
    // www.tubot.cl). Sin esto, el plan V2 público de conversia se filtraría a la web de
    // TuBot. conversia-web pide ?brand=conversia.
    const b = (brand ?? "tubot").toLowerCase();
    const plans = await this.prisma.admin.plan.findMany({
      where: { isPublic: true, active: true, brand: b },
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
   * V2-9 — packs de CONVERSACIONES públicos de una marca (modelo por conversación).
   * Acotado por marca (default conversia). Solo activos. Para la sección "recargas/packs"
   * de la web de precios V2.
   */
  @Get("conversation-packs")
  async conversationPacks(@Query("brand") brand?: string) {
    const b = (brand ?? "conversia").toLowerCase();
    // CRE 2 — la web pública muestra los packs del catálogo que está ACTIVO: créditos si el
    // dueño ya encendió ese modelo, conversaciones si no. `unit` viaja en la respuesta para
    // que la página sepa cómo nombrarlos (y si decir "IVA incluido").
    const unit = await packUnitForBrand(b);
    const packs = await this.prisma.admin.messagePackage.findMany({
      where: { active: true, brand: b, type: unit },
      orderBy: { order: "asc" },
    });
    // CRE 3 — `creditosPorConversacion` viaja con los packs para que la página de precios
    // pueda mostrar la equivalencia ("1.000 créditos ≈ 111 conversaciones") SIN hardcodear
    // el promedio en el navegador. El número lo manda el servidor, que es el mismo que usa
    // el estimador del panel: así la promesa de la landing y lo que el cliente ve adentro no
    // se contradicen. (Y evita arrastrar `@conversia/agents` al bundle del cliente.)
    // §1 — el BONO viaja calculado desde el precio y los créditos, nunca guardado: un bono
    // en una columna aparte se desincroniza del precio en la primera edición del super admin,
    // y entonces la página de precios promete un extra que el pack no da. La referencia es la
    // recarga básica, que en este listado es el pack más barato (`order` asc, precio asc).
    const bonos = bonoDePacks(packs.map((p) => ({ credits: p.credits, priceClp: Number(p.priceClp) })));
    return packs.map((p, i) => ({
      code: p.code,
      name: p.name,
      credits: p.credits,
      priceClp: Number(p.priceClp),
      priceUsd: Number(p.priceUsd),
      order: p.order,
      unit,
      /** Créditos extra respecto de la recarga básica, en %. 0 = sin bono que anunciar. */
      bonoPct: unit === "credit" ? bonos[i] : 0,
      creditosPorConversacion: CREDITOS_POR_CONVERSACION_POR_DEFECTO,
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

  /**
   * BLOQUE A — config pública del SDK de Meta (Embedded Signup) POR MARCA. Sirve
   * appId + config_id + versión para que /canales lance el popup sin hardcodear nada en
   * el build (corregible sin redeploy). Son valores PÚBLICOS (viven en el browser); el
   * secreto de la app jamás se expone. La marca se resuelve por ?brand= o por Origin.
   */
  @Get("meta-config")
  metaConfig(@Query("brand") brand: string | undefined, @Query("mode") mode: string | undefined, @Req() req: Request) {
    const env = getEnv();
    const b = (brand ?? brandFromOrigin(req.headers.origin as string | undefined)).toLowerCase();
    // mode=coexistence → config del onboarding de la app WhatsApp Business (conectar el
    // número que ya se usa). Cualquier otro valor = Embedded Signup normal (número dedicado).
    const coex = (mode ?? "").toLowerCase() === "coexistence";
    const esConfigId = b === "conversia" ? env.META_ES_CONFIG_ID_CONVERSIA || env.META_CONFIG_ID : env.META_CONFIG_ID;
    // El config_id de coexistencia cae a la config de ES de la marca si no se definió uno propio.
    const coexConfigId = b === "conversia" ? env.META_ES_COEX_CONFIG_ID_CONVERSIA || esConfigId : esConfigId;
    const configId = coex ? coexConfigId : esConfigId;
    const featureType = coex ? env.META_ES_COEX_FEATURE_TYPE : env.META_ES_FEATURE_TYPE;
    // Versión del "registro insertado": v4 (vigente) o v5 (GA futuro). La flag está APAGADA por
    // defecto; al encenderla por marca conversia, el front arma los extras del FB.login en v5
    // (sin featureType, sessionInfoVersion 5). Ver META_ES_V5_ENABLED_CONVERSIA.
    const esVersion = b === "conversia" && env.META_ES_V5_ENABLED_CONVERSIA ? "v5" : "v4";
    return {
      brand: b,
      mode: coex ? "coexistence" : "embedded_signup",
      appId: env.META_APP_ID,
      configId,
      graphVersion: env.META_GRAPH_VERSION,
      featureType,
      esVersion,
      // true si la marca ya tiene config → el front habilita el botón "Conectar".
      ready: Boolean(env.META_APP_ID && configId),
    };
  }

  /**
   * PELDAÑO 3 — mini-sitio público del negocio (conversia.cl/n/<slug>): para el cliente
   * SIN página web. Datos PÚBLICOS armados solos (nombre, rubro, servicios activos con
   * precio, horarios, botón de WhatsApp al número conectado, contacto). Sin auth. Expone
   * SOLO lo que el dueño publicó (miniSite.enabled) y NADA del CRM. Gateado a marca conversia.
   */
  @Get("n/:slug")
  async miniSite(@Param("slug") slug: string) {
    const admin = this.prisma.admin;
    const org = await admin.organization.findUnique({
      where: { slug },
      select: { id: true, name: true, brand: true, settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, any>;
    const ms = (settings.miniSite ?? {}) as Record<string, any>;
    // 404 si no existe, no es de Conversia, o el dueño no la publicó.
    if (!org || org.brand !== "conversia" || ms.enabled !== true) {
      throw new NotFoundException("Esta página no existe o no está publicada.");
    }
    const general = (settings.general ?? {}) as Record<string, any>;
    const rubro = INDUSTRIES.find((i) => i.code === general.industry)?.label ?? null;

    // Número de WhatsApp: override del mini-sitio o el número conectado (primero activo).
    let waNumber: string | null = ms.whatsapp ? String(ms.whatsapp) : null;
    if (!waNumber) {
      const num = await admin.whatsappPhoneNumber.findFirst({ where: { organizationId: org.id, status: "active" }, select: { displayPhone: true } }).catch(() => null);
      waNumber = num?.displayPhone ?? null;
    }
    const waDigits = waNumber ? waNumber.replace(/\D/g, "") : null;
    const waLink = waDigits ? `https://wa.me/${waDigits}${ms.waText ? `?text=${encodeURIComponent(String(ms.waText))}` : ""}` : null;

    // Servicios activos (público). Jamás contactos/conversaciones/datos del CRM.
    let services: { name: string; price: number | null; currency: string; description: string | null }[] = [];
    if (ms.showServices !== false) {
      const rows = await admin.service
        .findMany({ where: { organizationId: org.id, active: true }, select: { name: true, price: true, currency: true, description: true }, orderBy: { name: "asc" }, take: 60 })
        .catch(() => []);
      services = rows.map((r) => ({ name: r.name, price: r.price != null ? Number(r.price) : null, currency: r.currency, description: r.description ?? null }));
    }

    return {
      slug,
      name: org.name,
      rubro,
      tagline: ms.tagline ? String(ms.tagline) : null,
      about: ms.about ? String(ms.about) : null,
      whatsapp: waLink ? { number: waNumber, link: waLink } : null,
      services,
      hours: ms.hours ? String(ms.hours) : null,
      contact: {
        address: ms.address ? String(ms.address) : null,
        instagram: ms.instagram ? String(ms.instagram) : null,
        email: general.contactEmail ? String(general.contactEmail) : null,
        phone: ms.whatsapp ? null : general.contactPhone ? String(general.contactPhone) : null,
      },
      accent: general.accent ? String(general.accent) : null,
    };
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
    // §3.7 — IP real del cliente vía `req.ip` (Express la deriva con `trust proxy`, ver main.ts).
    // Leer a mano el primer valor de X-Forwarded-For la hacía FALSIFICABLE: el cliente mandaba
    // la cabecera a su antojo y se saltaba el antiabuso por IP de /crear (máx 3 drafts/hora).
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
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
