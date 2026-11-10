import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { getEnv } from "@conversia/config";
import { createAIProvider } from "@conversia/agents";
import type { AIChatMessage, AssistantAction } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { configEfectiva, readAssistantConfig, resolveAssistantModel } from "./assistant-config";

/**
 * B2 — EL HILO DE CONVI VIVE EN LA BASE, NO EN EL NAVEGADOR.
 *
 * Antes el historial era el `useState` del widget y el contexto del modelo lo mandaba el
 * cliente en cada turno. Dos consecuencias: cambiar de sección (la navegación del panel
 * recarga la página) borraba la conversación, y lo que el modelo "recordaba" era lo que el
 * navegador dijera — manipulable desde afuera.
 *
 * Ahora el servidor es el dueño del hilo: elige cuál, lo lee de la base y lo guarda. El
 * campo `history` del cuerpo sigue aceptándose por compatibilidad, pero se IGNORA.
 */

/** Cuántos mensajes del hilo viajan al modelo en cada turno. */
export const MENSAJES_EN_EL_PROMPT = 20;
/** A partir de cuántos mensajes se resume lo viejo (y deja de viajar entero). */
export const UMBRAL_DE_RESUMEN = 40;
/** Página del historial. */
export const MENSAJES_POR_PAGINA = 50;

export interface HiloResumen {
  id: string;
  title: string | null;
  status: string;
  lastMessageAt: Date;
  createdAt: Date;
  /** Primera línea del hilo, para la lista. */
  preview: string | null;
  /** Solo para administradores: de quién es el hilo. */
  userName?: string | null;
}

/** Título automático: las primeras 6 palabras de lo primero que escribió el dueño. */
export function tituloDesde(mensaje: string): string | null {
  const palabras = mensaje.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!palabras.length) return null;
  return palabras.join(" ").slice(0, 80);
}

@Injectable()
export class AssistantThreadsService {
  constructor(private prisma: PrismaService) {}

  /**
   * El hilo donde escribir. Con `threadId` comprueba que sea de ESTE usuario y de esta
   * organización —que alguien mande el id de un hilo ajeno es exactamente el ataque que hay
   * que cerrar—; sin él, toma el abierto o crea uno.
   */
  async hiloParaEscribir(organizationId: string, userId: string, threadId?: string): Promise<{ id: string; summary: string | null }> {
    return this.prisma.withTenant(organizationId, async (tx) => {
      if (threadId) {
        const h = await tx.assistantThread.findFirst({ where: { id: threadId, userId }, select: { id: true, summary: true, status: true } });
        // 404 y no 403: un hilo ajeno no debe ni confirmarse que existe.
        if (!h) throw new NotFoundException("Conversación no encontrada");
        if (h.status !== "open") await tx.assistantThread.update({ where: { id: h.id }, data: { status: "open" } });
        return { id: h.id, summary: h.summary };
      }
      const abierto = await tx.assistantThread.findFirst({ where: { userId, status: "open" }, orderBy: { lastMessageAt: "desc" }, select: { id: true, summary: true } });
      if (abierto) return abierto;
      const nuevo = await tx.assistantThread.create({ data: { organizationId, userId, status: "open" }, select: { id: true, summary: true } });
      return nuevo;
    });
  }

  /** Los últimos mensajes del hilo, en orden cronológico, listos para el prompt. */
  async historialParaElPrompt(organizationId: string, threadId: string, limite = MENSAJES_EN_EL_PROMPT): Promise<AIChatMessage[]> {
    const filas = await this.prisma.withTenant(organizationId, (tx) =>
      tx.assistantMessage.findMany({ where: { threadId }, orderBy: { createdAt: "desc" }, take: limite, select: { role: true, content: true } }),
    );
    return filas
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));
  }

  /**
   * Guarda el turno completo (lo que escribió el dueño y lo que contestó Convi).
   *
   * Best-effort a propósito: si la base falla, el dueño YA tiene su respuesta en pantalla y
   * perder el registro es mucho menos grave que convertir un turno bueno en un error.
   */
  async guardarTurno(input: {
    organizationId: string;
    threadId: string;
    userMessage: string;
    reply: string;
    route?: string;
    actions?: AssistantAction[];
    /** SOLO metadatos: tipo y nombre. El archivo no se guarda. */
    adjuntos?: Array<{ tipo: string; nombre?: string }>;
  }): Promise<void> {
    try {
      await this.prisma.withTenant(input.organizationId, async (tx) => {
        const hilo = await tx.assistantThread.findUnique({ where: { id: input.threadId }, select: { title: true } });
        await tx.assistantMessage.create({
          data: {
            organizationId: input.organizationId,
            threadId: input.threadId,
            role: "user",
            content: input.userMessage || "(sin texto)",
            route: input.route ?? null,
            adjuntos: input.adjuntos?.length ? (input.adjuntos.map((a) => ({ tipo: a.tipo, nombre: a.nombre ?? null })) as object) : undefined,
          },
        });
        await tx.assistantMessage.create({
          data: {
            organizationId: input.organizationId,
            threadId: input.threadId,
            role: "assistant",
            content: input.reply,
            actions: input.actions?.length ? (input.actions as unknown as object) : undefined,
          },
        });
        await tx.assistantThread.update({
          where: { id: input.threadId },
          data: {
            lastMessageAt: new Date(),
            // El título se pone con el PRIMER mensaje del dueño y ya no se toca.
            ...(hilo?.title ? {} : { title: tituloDesde(input.userMessage) }),
          },
        });
      });
    } catch (e) {
      console.error(`✖ Convi: no se pudo guardar el turno (${(e as Error).message?.slice(0, 120)})`);
    }
  }

  /**
   * Cuando el hilo pasa de 40 mensajes, resume los VIEJOS en `thread.summary` para que el
   * prompt siga siendo `resumen + últimos 20`. Sin esto, una conversación larga o se corta
   * (Convi pierde lo acordado al principio) o crece sin techo en cada turno.
   *
   * Best-effort y con el modelo BARATO del proveedor configurado: resumir no puede costar
   * como responder, y si falla el hilo sigue andando con sus últimos 20.
   */
  async resumirSiHaceFalta(organizationId: string, threadId: string): Promise<void> {
    try {
      const datos = await this.prisma.withTenant(organizationId, async (tx) => {
        const total = await tx.assistantMessage.count({ where: { threadId } });
        if (total <= UMBRAL_DE_RESUMEN) return null;
        const hilo = await tx.assistantThread.findUnique({ where: { id: threadId }, select: { summary: true } });
        // Lo VIEJO: todo menos los últimos 20, que ya viajan enteros en el prompt.
        const viejos = await tx.assistantMessage.findMany({
          where: { threadId },
          orderBy: { createdAt: "asc" },
          take: total - MENSAJES_EN_EL_PROMPT,
          select: { role: true, content: true },
        });
        return { resumenPrevio: hilo?.summary ?? null, viejos };
      });
      if (!datos || !datos.viejos.length) return;

      const env = getEnv();
      const cfg = configEfectiva(await readAssistantConfig(), env);
      // El modelo BARATO del proveedor configurado (haiku en Anthropic, mini en OpenAI).
      // `resolveAssistantModel` lo traduce: mandarle un `claude-*` a OpenAI da 404, y el
      // router lo remapearía en silencio. Si no hay traducción, cae al modelo principal.
      const modelo = resolveAssistantModel(cfg.provider, env.AI_FALLBACK_MODEL) || cfg.model;
      const ai = createAIProvider({ provider: cfg.provider, anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY });
      const transcripcion = datos.viejos.map((m) => `${m.role === "assistant" ? "Convi" : "Dueño"}: ${m.content}`).join("\n").slice(0, 12000);
      const resp = await ai.chat({
        model: modelo,
        system:
          "Resume en español de Chile, en 6 líneas como máximo, lo que el dueño de un negocio y su copiloto acordaron o dejaron pendiente. Guarda DATOS concretos (nombres, precios, horarios, decisiones) y descarta la charla. No inventes nada que no esté.",
        messages: [
          { role: "user", content: `${datos.resumenPrevio ? `Resumen anterior:\n${datos.resumenPrevio}\n\n` : ""}Conversación:\n${transcripcion}` },
        ],
        maxTokens: 400,
      });
      const resumen = (resp.text ?? "").trim();
      if (!resumen) return;
      await this.prisma.withTenant(organizationId, (tx) =>
        tx.assistantThread.update({ where: { id: threadId }, data: { summary: resumen.slice(0, 4000) } }),
      );
    } catch (e) {
      console.error(`✖ Convi: no se pudo resumir el hilo (${(e as Error).message?.slice(0, 120)})`);
    }
  }

  /** Los hilos del usuario. Un administrador ve los de toda su organización. */
  async listar(organizationId: string, userId: string, opts: { esAdmin: boolean; limite?: number; antesDe?: Date }): Promise<{ hilos: HiloResumen[]; siguiente: string | null }> {
    const limite = Math.min(Math.max(opts.limite ?? 20, 1), 50);
    return this.prisma.withTenant(organizationId, async (tx) => {
      const hilos = await tx.assistantThread.findMany({
        where: { ...(opts.esAdmin ? {} : { userId }), ...(opts.antesDe ? { lastMessageAt: { lt: opts.antesDe } } : {}) },
        orderBy: { lastMessageAt: "desc" },
        take: limite + 1,
        select: { id: true, title: true, status: true, lastMessageAt: true, createdAt: true, userId: true },
      });
      const pagina = hilos.slice(0, limite);
      // Primera línea de cada hilo y, si quien mira es administrador, de quién es.
      const nombres = new Map<string, string | null>();
      if (opts.esAdmin && pagina.length) {
        const ids = [...new Set(pagina.map((h) => h.userId))];
        const usuarios = await this.prisma.admin.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }).catch(() => []);
        for (const u of usuarios) nombres.set(u.id, u.name ?? null);
      }
      const previews = new Map<string, string | null>();
      for (const h of pagina) {
        const primero = await tx.assistantMessage.findFirst({ where: { threadId: h.id, role: "user" }, orderBy: { createdAt: "asc" }, select: { content: true } });
        previews.set(h.id, primero?.content?.slice(0, 120) ?? null);
      }
      return {
        hilos: pagina.map((h) => ({
          id: h.id,
          title: h.title,
          status: h.status,
          lastMessageAt: h.lastMessageAt,
          createdAt: h.createdAt,
          preview: previews.get(h.id) ?? null,
          ...(opts.esAdmin ? { userName: nombres.get(h.userId) ?? null } : {}),
        })),
        siguiente: hilos.length > limite ? pagina[pagina.length - 1].lastMessageAt.toISOString() : null,
      };
    });
  }

  /** Los mensajes de un hilo, cronológicos y paginados por cursor. */
  async mensajes(organizationId: string, userId: string, threadId: string, opts: { esAdmin: boolean; cursor?: Date }) {
    return this.prisma.withTenant(organizationId, async (tx) => {
      const hilo = await tx.assistantThread.findFirst({ where: { id: threadId }, select: { id: true, userId: true, title: true, status: true, summary: true } });
      if (!hilo) throw new NotFoundException("Conversación no encontrada");
      // Un usuario no lee el hilo de otro, aunque sea de su misma organización.
      if (!opts.esAdmin && hilo.userId !== userId) throw new NotFoundException("Conversación no encontrada");
      const filas = await tx.assistantMessage.findMany({
        where: { threadId, ...(opts.cursor ? { createdAt: { gt: opts.cursor } } : {}) },
        orderBy: { createdAt: "asc" },
        take: MENSAJES_POR_PAGINA + 1,
        select: { id: true, role: true, content: true, actions: true, adjuntos: true, createdAt: true },
      });
      const pagina = filas.slice(0, MENSAJES_POR_PAGINA);
      return {
        thread: { id: hilo.id, title: hilo.title, status: hilo.status },
        messages: pagina,
        siguiente: filas.length > MENSAJES_POR_PAGINA ? pagina[pagina.length - 1].createdAt.toISOString() : null,
      };
    });
  }

  /** "Nueva conversación": archiva la abierta y abre otra. */
  async nuevoHilo(organizationId: string, userId: string): Promise<{ id: string }> {
    return this.prisma.withTenant(organizationId, async (tx) => {
      await tx.assistantThread.updateMany({ where: { userId, status: "open" }, data: { status: "archived" } });
      const h = await tx.assistantThread.create({ data: { organizationId, userId, status: "open" }, select: { id: true } });
      return h;
    });
  }

  /** Renombrar o archivar/reabrir. Solo el dueño del hilo (o un administrador). */
  async actualizar(organizationId: string, userId: string, threadId: string, cambios: { title?: string; status?: "open" | "archived" }, esAdmin: boolean) {
    return this.prisma.withTenant(organizationId, async (tx) => {
      const hilo = await tx.assistantThread.findFirst({ where: { id: threadId }, select: { id: true, userId: true } });
      if (!hilo) throw new NotFoundException("Conversación no encontrada");
      if (!esAdmin && hilo.userId !== userId) throw new ForbiddenException("No puedes cambiar una conversación de otra persona");
      // Reabrir exige que no haya otra abierta: la base lo impide con un índice único
      // parcial, así que se archiva la que esté antes de reabrir esta.
      if (cambios.status === "open") {
        await tx.assistantThread.updateMany({ where: { userId: hilo.userId, status: "open", id: { not: threadId } }, data: { status: "archived" } });
      }
      await tx.assistantThread.update({
        where: { id: threadId },
        data: { ...(cambios.title !== undefined ? { title: cambios.title.slice(0, 80) || null } : {}), ...(cambios.status ? { status: cambios.status } : {}) },
      });
      return { ok: true };
    });
  }
}
