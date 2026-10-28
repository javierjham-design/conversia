import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, NotFoundException, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { buildCoreTools } from "@conversia/agents";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { enforcePlanLimit } from "../common/plan-limits";
import { RateLimitService } from "../common/rate-limit";
// Lógica/schemas compartidos con la consola de plataforma (una sola fuente de verdad).
import { createAgentSchema, draftSchema, testSchema, DEFAULT_PROMPT, slugify, runAgentTest } from "./agent-test";
import { runQaBattery } from "./agent-qa";
import { explainQaResults, qaHeadline } from "./qa-report";
import { assignPublishedAgentToChannelsSafe } from "./assign-agent-to-channels";
import { applyModelLock, defaultAgentModel } from "./model-policy";
import { applyAgentModel, clearPendingModelChange, readPendingModelChanges } from "./model-change";

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

@Controller("agents")
export class AgentsController {
  constructor(
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
  ) {}

  /** Catálogo de herramientas disponibles para habilitar por agente. */
  @Get("meta/tools")
  toolCatalog() {
    return buildCoreTools().map((t) => ({ name: t.name, description: t.description }));
  }

  /** Bases de conocimiento del tenant, para elegir cuáles usa cada agente. */
  @Get("meta/knowledge")
  knowledgeBases() {
    const ctx = requirePermission("agents:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const bases = await tx.knowledgeBase.findMany({
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { documents: { where: { status: "PUBLISHED" } } } } },
      });
      return bases.map((b) => ({ id: b.id, name: b.name, description: b.description, publishedDocs: b._count.documents }));
    });
  }

  @Get()
  list() {
    const ctx = requirePermission("agents:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const agents = await tx.agent.findMany({
        where: { deletedAt: null },
        include: {
          versions: { orderBy: { version: "desc" }, take: 5 },
        },
        orderBy: { createdAt: "asc" },
      });
      return agents.map((a) => {
        const published = a.versions.find((v) => v.status === "PUBLISHED");
        const draft = a.versions.find((v) => v.status === "DRAFT");
        return {
          id: a.id,
          slug: a.slug,
          name: a.name,
          kind: a.kind,
          description: a.description,
          active: a.active,
          publishedVersion: published?.version ?? null,
          publishedAt: published?.publishedAt ?? null,
          hasDraft: Boolean(draft && (!published || draft.version > published.version)),
          model: ((published ?? draft)?.config as any)?.model ?? null,
          avatar: ((published ?? draft)?.config as any)?.emoji ?? null,
        };
      });
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    const input = parse(createAgentSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await enforcePlanLimit(tx, "agents", await tx.agent.count({ where: { deletedAt: null } }));
      let slug = slugify(input.name) || "agente";
      const existing = await tx.agent.findUnique({
        where: { organizationId_slug: { organizationId: ctx.organizationId, slug } },
      });
      if (existing) slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;

      const agent = await tx.agent.create({
        data: {
          organizationId: ctx.organizationId,
          slug,
          name: input.name,
          kind: input.kind,
          description: input.description,
          active: true,
        },
      });
      await tx.agentVersion.create({
        data: {
          organizationId: ctx.organizationId,
          agentId: agent.id,
          version: 1,
          status: "DRAFT",
          systemPrompt: DEFAULT_PROMPT,
          // CRE 1 — el modelo del bot nuevo sale de configuración (platform_settings),
          // no de una constante acá: el equipo de Conversia cambia el estándar sin desplegar.
          config: { model: await defaultAgentModel(), maxTokens: 400, maxToolRounds: 5, language: "es" },
          tools: ["getServices", "getServicePrice", "searchKnowledgeBase", "transferToHuman"],
          changelog: "Borrador inicial",
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "agent.create",
          entityType: "agent",
          entityId: agent.id,
        },
      });
      return agent;
    });
  }

  /** Lista liviana de agentes activos para asignar en la bandeja (cualquier miembro). */
  /**
   * CRE 1 (§4) — cambios de modelo de IA que el equipo de Conversia propuso y esperan tu
   * aceptación. El panel los muestra como aviso con el impacto en el saldo. Si no hay
   * ninguno, devuelve la lista vacía (el banner no aparece).
   *
   * Va ANTES de `@Get(":id")` a propósito: si no, Nest tomaría "model-changes" como un id.
   */
  @Get("model-changes")
  async modelChanges() {
    const ctx = requirePermission("agents:read");
    return { pending: await readPendingModelChanges(ctx.organizationId) };
  }

  /**
   * El cliente ACEPTA (o rechaza) el modelo propuesto. Su decisión queda registrada con
   * fecha y usuario, que es lo que pedía la decisión del dueño: nadie le sube el consumo
   * sin que él lo haya dicho.
   */
  @Post("model-changes/:agentId")
  async decideModelChange(@Param("agentId") agentId: string, @Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    const parsed = z.object({ accept: z.boolean() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("accept requerido (true o false)");
    const pendientes = await readPendingModelChanges(ctx.organizationId);
    const pedido = pendientes.find((p) => p.agentId === agentId);
    if (!pedido) throw new NotFoundException("No hay un cambio de modelo pendiente para ese asistente");

    if (parsed.data.accept) await applyAgentModel(ctx.organizationId, agentId, pedido.to);
    await clearPendingModelChange(ctx.organizationId, agentId);
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: parsed.data.accept ? "agent.model_change_accepted" : "agent.model_change_declined",
          entityType: "agent",
          entityId: agentId,
          before: { model: pedido.from },
          after: { model: parsed.data.accept ? pedido.to : pedido.from, requestedAt: pedido.requestedAt },
        },
      }),
    );
    return { ok: true, applied: parsed.data.accept, model: parsed.data.accept ? pedido.to : pedido.from };
  }

  @Get("assignable")
  assignable() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.agent.findMany({
        where: { deletedAt: null, active: true },
        select: { id: true, name: true, slug: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    const ctx = requirePermission("agents:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const agent = await tx.agent.findFirst({
        where: { id, deletedAt: null },
        include: { versions: { orderBy: { version: "desc" }, take: 20 } },
      });
      if (!agent) throw new NotFoundException("Agente no encontrado");
      const published = agent.versions.find((v) => v.status === "PUBLISHED");
      const draft = agent.versions.find(
        (v) => v.status === "DRAFT" && (!published || v.version > published.version),
      );
      const editing = draft ?? published ?? agent.versions[0];
      return {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        kind: agent.kind,
        description: agent.description,
        active: agent.active,
        publishedVersion: published?.version ?? null,
        draftVersion: draft?.version ?? null,
        editing: editing
          ? {
              systemPrompt: editing.systemPrompt,
              config: editing.config,
              tools: editing.tools,
              status: editing.status,
              version: editing.version,
            }
          : null,
        versions: agent.versions.map((v) => ({
          version: v.version,
          status: v.status,
          changelog: v.changelog,
          publishedAt: v.publishedAt,
          createdAt: v.createdAt,
        })),
      };
    });
  }

  /**
   * Probador en vivo del editor. Ejecuta un turno del agente con la configuración
   * ACTUAL (aún sin publicar) contra un entorno de PRUEBA:
   *  - Lecturas reales (servicios, precios, agenda, conocimiento del tenant).
   *  - Escrituras SIMULADAS: no persiste conversaciones, leads, citas ni notas.
   * Respeta el kill switch, la suspensión, la vigencia y el tope diario de tokens
   * (la prueba consume tokens reales del proveedor), y registra ese consumo.
   */
  @Post(":id/test")
  async test(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    // Antiabuso (auditoría sim 250): la prueba consume tokens REALES del proveedor y no
    // tenía tope → quema de dinero por loop/script. Mismo criterio que el asistente.
    const rl = await this.rateLimit.custom(`rl:agent-test:${ctx.userId ?? ctx.organizationId}`, 30, 300);
    if (!rl.allowed) throw new HttpException("Demasiadas pruebas seguidas. Espera unos segundos.", HttpStatus.TOO_MANY_REQUESTS);
    const input = parse(testSchema, body);
    return runAgentTest(this.prisma, ctx.organizationId, id, input);
  }

  /** Guarda el borrador: actualiza el DRAFT vigente o crea la versión siguiente. */
  @Put(":id/draft")
  saveDraft(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    const input = parse(draftSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw new NotFoundException("Agente no encontrado");

      if (input.name || input.kind || input.description !== undefined) {
        await tx.agent.update({
          where: { id },
          data: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        });
      }

      const latest = await tx.agentVersion.findFirst({
        where: { agentId: id },
        orderBy: { version: "desc" },
      });
      // CRE 1 — CANDADO DE MODELO (§4): en Conversia el modelo lo fija la plataforma. Se
      // conserva el que ya tenía el agente y se ignora el que venga en el cuerpo. Sin
      // esto, un cliente podía pasarse a claude-opus con curl y multiplicar por 50 su
      // consumo de créditos sin saberlo.
      const candado = await applyModelLock({
        organizationId: ctx.organizationId,
        incoming: input.config as Record<string, unknown>,
        current: (latest?.config ?? null) as Record<string, unknown> | null,
      });
      if (candado.overridden) {
        await tx.auditLog.create({
          data: {
            organizationId: ctx.organizationId,
            actorType: "user",
            actorId: ctx.userId,
            action: "agent.model_change_rejected",
            entityType: "agent",
            entityId: id,
            before: { model: candado.requested ?? null },
            after: { model: candado.config.model ?? null },
          },
        });
      }
      const data = {
        systemPrompt: input.systemPrompt,
        config: candado.config as object,
        tools: input.tools,
        changelog: input.changelog ?? null,
        createdById: ctx.userId,
      };
      let version;
      if (latest && latest.status === "DRAFT") {
        version = await tx.agentVersion.update({ where: { id: latest.id }, data });
      } else {
        version = await tx.agentVersion.create({
          data: {
            organizationId: ctx.organizationId,
            agentId: id,
            version: (latest?.version ?? 0) + 1,
            status: "DRAFT",
            ...data,
          },
        });
      }
      return { ok: true, draftVersion: version.version };
    });
  }

  /**
   * ETAPA 0 (hallazgo 1) — PUBLICACIÓN EN EL FLUJO DEL CLIENTE. El paquete vertical deja los
   * agentes en BORRADOR y hasta hoy solo el super admin podía correr la batería de auto-QA, así
   * que el cliente se quedaba para siempre en "Asistente en preparación".
   *
   * Corre `runQaBattery` con `autoPublish: true` sobre el agente de SU organización:
   *  - batería verde  → publica (y asigna el agente a los canales que no tengan uno).
   *  - batería roja   → NO publica y devuelve, en lenguaje simple, qué falló y cómo arreglarlo.
   * Siempre queda auditado (`agent.qa_publish`). El uso del super admin (platform.controller)
   * no se toca: `runQaBattery` queda igual.
   */
  @Post(":id/qa-publish")
  async qaPublish(@Param("id") id: string) {
    const ctx = requirePermission("agents:write");
    // La batería ejecuta varios turnos reales del agente (tokens del proveedor): mismo criterio
    // antiabuso que el probador, pero más estricto porque cada corrida son 4+ llamadas.
    const rl = await this.rateLimit.custom(`rl:agent-qa:${ctx.userId ?? ctx.organizationId}`, 6, 300);
    if (!rl.allowed) {
      throw new HttpException(
        "Ya probamos tu asistente varias veces seguidas. Espera un par de minutos y vuelve a intentar.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const agent = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.agent.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } }),
    );
    if (!agent) throw new NotFoundException("Agente no encontrado");

    const qa = await runQaBattery(this.prisma, ctx.organizationId, id, { autoPublish: true });

    if (!qa.ok) {
      // Sin versión guardada (o la batería no pudo arrancar): mensaje entendible, no un 500.
      const problemas = explainQaResults([{ name: "preparación", pass: false, reason: qa.error ?? "error" }]);
      await this.auditQaPublish(ctx.organizationId, ctx.userId, id, qa, problemas);
      return {
        ok: false,
        passed: false,
        published: false,
        corrected: false,
        mensaje:
          qa.error === "sin versión del agente"
            ? "Tu asistente todavía no tiene instrucciones guardadas. Guárdalo y vuelve a intentar."
            : qaHeadline({ passed: false, published: false, corrected: false }, problemas.length),
        problemas,
        escenarios: [],
      };
    }

    const problemas = explainQaResults(qa.results);
    // Recién publicado → que alguien lo use: se asigna a los canales sin agente por defecto
    // (solo marca conversia, idempotente). Fail-soft: nunca tumba la publicación.
    const canales = qa.published
      ? await assignPublishedAgentToChannelsSafe(this.prisma, ctx.organizationId, { preferAgentId: id, actorId: ctx.userId })
      : { assigned: 0, agentId: null as string | null, channelIds: [] as string[] };

    await this.auditQaPublish(ctx.organizationId, ctx.userId, id, qa, problemas);

    return {
      ok: true,
      passed: qa.passed,
      published: qa.published,
      corrected: qa.corrected,
      mensaje: qaHeadline(qa, problemas.length),
      problemas,
      canalesAsignados: canales.assigned,
      // Detalle técnico para soporte (el cliente ve `problemas`).
      escenarios: qa.results,
    };
  }

  /** Deja constancia de cada intento de publicación del cliente (pase o falle). */
  private auditQaPublish(
    orgId: string,
    userId: string | undefined,
    agentId: string,
    qa: { passed: boolean; published: boolean; corrected: boolean; results?: { name: string; pass: boolean }[] },
    problemas: { titulo: string }[],
  ) {
    return this.prisma
      .withTenant(orgId, (tx) =>
        tx.auditLog.create({
          data: {
            organizationId: orgId,
            actorType: "user",
            actorId: userId,
            action: "agent.qa_publish",
            entityType: "agent",
            entityId: agentId,
            after: {
              passed: qa.passed,
              published: qa.published,
              corrected: qa.corrected,
              fallos: (qa.results ?? []).filter((r) => !r.pass).map((r) => r.name),
              problemas: problemas.map((p) => p.titulo),
            },
          },
        }),
      )
      .then(() => undefined)
      .catch((e) => {
        console.error("✖ auditar qa-publish:", (e as Error)?.message ?? e);
      });
  }

  /** Publica el borrador: pasa a PRODUCCIÓN inmediatamente para nuevas respuestas. */
  @Post(":id/publish")
  async publish(@Param("id") id: string) {
    const ctx = requirePermission("agents:write");
    const out = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const draft = await tx.agentVersion.findFirst({
        where: { agentId: id, status: "DRAFT" },
        orderBy: { version: "desc" },
      });
      if (!draft) throw new BadRequestException("No hay borrador para publicar");
      const published = await tx.agentVersion.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      await tx.agent.update({ where: { id }, data: { currentVersionId: published.id } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "agent.publish",
          entityType: "agent",
          entityId: id,
          after: { version: published.version },
        },
      });
      return { ok: true, publishedVersion: published.version };
    });
    // ETAPA 0 (hallazgo 2) — si el agente se publica DESPUÉS de conectar el canal, se asigna
    // a los canales que no tengan agente. Gateado a marca conversia e idempotente: para TuBot
    // sale antes de tocar nada.
    await assignPublishedAgentToChannelsSafe(this.prisma, ctx.organizationId, { preferAgentId: id, actorId: ctx.userId });
    return out;
  }

  @Post(":id/active")
  setActive(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    const input = parse(z.object({ active: z.boolean() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.agent.update({ where: { id }, data: { active: input.active } });
      return { ok: true, active: input.active };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("agents:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const usedAsDefault = await tx.channelConnection.findFirst({ where: { defaultAgentId: id } });
      if (usedAsDefault) {
        throw new BadRequestException(
          `Este agente es el agente por defecto del canal "${usedAsDefault.name}". Cambia el canal antes de eliminarlo.`,
        );
      }
      await tx.agent.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "agent.delete",
          entityType: "agent",
          entityId: id,
        },
      });
      return { ok: true };
    });
  }
}
