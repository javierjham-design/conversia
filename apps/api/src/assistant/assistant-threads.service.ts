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

/** Tope del resumen de herramientas por turno. Es una PISTA, no el resultado entero. */
export const LARGO_TOOL_DIGEST = 300;

/** Salto de línea, aparte para que las instrucciones del resumen se lean en el código. */
const SALTO = String.fromCharCode(10);

/** El turno se respondió pero NO se pudo guardar. El widget lo dice y ofrece reintentar. */
export class ErrorAlGuardarTurno extends Error {
  constructor(detalle: string) {
    super(detalle);
    this.name = "ErrorAlGuardarTurno";
  }
}
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
      tx.assistantMessage.findMany({
        where: { threadId },
        orderBy: { createdAt: "desc" },
        take: limite,
        select: { role: true, content: true, toolDigest: true },
      }),
    );
    return filas.reverse().map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      // E1.f — lo CONSULTADO va pegado al turno, entre paréntesis. Sin esto el modelo no sabe
      // que ya miró el estado de la cuenta hace dos mensajes y lo vuelve a preguntar.
      content: m.toolDigest ? `${m.content}
(consulté ${m.toolDigest})` : m.content,
    }));
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
    /** E1.f — qué consultó Convi en este turno, resumido. */
    toolDigest?: string | null;
    /**
     * E1.e — DEVUELVE si pudo guardar en vez de tragárselo. Sigue sin lanzar NUNCA: la
     * promesa de que un fallo de base no le cueste la respuesta al dueño es literal. Lo que
     * cambia es que el widget se entera y puede decirlo, en vez de que el turno desaparezca
     * en silencio y el dueño lo descubra al reabrir.
     */
  }): Promise<{ guardado: boolean }> {
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
            toolDigest: input.toolDigest?.trim() ? input.toolDigest.trim().slice(0, LARGO_TOOL_DIGEST) : undefined,
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
      // E1.e — se registra con org y usuario para poder perseguirlo, NUNCA con el contenido
      // del mensaje: el hilo de Convi tiene datos del negocio y no van a los logs.
      console.error(
        `✖ Convi: no se pudo guardar el turno — org=${input.organizationId} hilo=${input.threadId} (${(e as Error).message?.slice(0, 120)})`,
      );
      return { guardado: false };
    }
    return { guardado: true };
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
          select: { role: true, content: true, toolDigest: true },
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
          // E1.f — el resumen se pide ESTRUCTURADO. Un resumen en prosa se lee lindo y no
          // sirve para retomar: lo que hace falta al reabrir es saber qué quedó decidido y
          // qué quedó a medias, para poder decir "quedamos en el pago del plan, ¿seguimos?".
          "Resume en español de Chile lo que el dueño de un negocio y su copiloto hablaron. " +
          "Responde EXACTAMENTE con estas tres secciones y nada más:" + SALTO +
          "CONTEXTO: 3 líneas como máximo con los datos concretos (nombres, precios, horarios)." + SALTO +
          "DECISIONES: lo que quedó resuelto, una por línea. Si no hay, escribe «ninguna»." + SALTO +
          "PENDIENTES: lo que quedó a medias o para después, una por línea, empezando por el verbo. Si no hay, escribe «ninguno»." + SALTO +
          "No inventes nada que no esté en la conversación.",
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
  /**
   * Los hilos. Un administrador ve los de toda la organización, EXCEPTO cuando pide `mine`.
   *
   * El widget pide `mine` siempre: antes tomaba «el primer hilo abierto» de la lista y, para
   * un dueño, ese hilo podía ser de OTRO usuario. Después `hiloParaEscribir` respondía 404 —
   * correctamente, un hilo ajeno no se escribe— y el widget mostraba «El asistente no está
   * disponible en esta cuenta». La vista de toda la organización queda para la página de
   * historial, que es donde tiene sentido.
   */
  async listar(organizationId: string, userId: string, opts: { esAdmin: boolean; soloMios?: boolean; limite?: number; antesDe?: Date }): Promise<{ hilos: HiloResumen[]; siguiente: string | null }> {
    const limite = Math.min(Math.max(opts.limite ?? 20, 1), 50);
    const verTodos = opts.esAdmin && !opts.soloMios;
    return this.prisma.withTenant(organizationId, async (tx) => {
      const hilos = await tx.assistantThread.findMany({
        where: { ...(verTodos ? {} : { userId }), ...(opts.antesDe ? { lastMessageAt: { lt: opts.antesDe } } : {}) },
        orderBy: { lastMessageAt: "desc" },
        take: limite + 1,
        select: { id: true, title: true, status: true, lastMessageAt: true, createdAt: true, userId: true },
      });
      const pagina = hilos.slice(0, limite);
      // Primera línea de cada hilo y, si quien mira es administrador, de quién es.
      const nombres = new Map<string, string | null>();
      if (verTodos && pagina.length) {
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
          // `userId` siempre: el widget necesita saber cuál hilo es SUYO.
          userId: h.userId,
          ...(verTodos ? { userName: nombres.get(h.userId) ?? null } : {}),
        })),
        siguiente: hilos.length > limite ? pagina[pagina.length - 1].lastMessageAt.toISOString() : null,
      };
    });
  }

  /**
   * Los mensajes de un hilo. Devuelve la ÚLTIMA página, no la primera.
   *
   * Antes traía los 50 más antiguos en orden ascendente. Con 25 turnos de conversación eso
   * significa que al reabrir el widget el dueño veía el principio de lo que habló —y nunca lo
   * último—, que es exactamente la queja de «Convi se olvida». El cursor `antesDe` sirve para
   * subir hacia atrás, que es como se lee un chat.
   *
   * `cursor` (hacia adelante) se mantiene por compatibilidad del contrato.
   */
  async mensajes(organizationId: string, userId: string, threadId: string, opts: { esAdmin: boolean; cursor?: Date; antesDe?: Date }) {
    return this.prisma.withTenant(organizationId, async (tx) => {
      const hilo = await tx.assistantThread.findFirst({ where: { id: threadId }, select: { id: true, userId: true, title: true, status: true, summary: true } });
      if (!hilo) throw new NotFoundException("Conversación no encontrada");
      // Un usuario no lee el hilo de otro, aunque sea de su misma organización.
      if (!opts.esAdmin && hilo.userId !== userId) throw new NotFoundException("Conversación no encontrada");
      // `cursor` (hacia adelante, contrato viejo) sigue funcionando; sin él se trae la cola.
      const haciaAdelante = !!opts.cursor;
      const filas = await tx.assistantMessage.findMany({
        where: {
          threadId,
          ...(opts.cursor ? { createdAt: { gt: opts.cursor } } : {}),
          ...(opts.antesDe ? { createdAt: { lt: opts.antesDe } } : {}),
        },
        orderBy: { createdAt: haciaAdelante ? "asc" : "desc" },
        take: MENSAJES_POR_PAGINA + 1,
        select: { id: true, role: true, content: true, actions: true, adjuntos: true, createdAt: true, toolDigest: true },
      });
      const recorte = filas.slice(0, MENSAJES_POR_PAGINA);
      const pagina = haciaAdelante ? recorte : [...recorte].reverse();
      const hayMas = filas.length > MENSAJES_POR_PAGINA;
      return {
        thread: { id: hilo.id, title: hilo.title, status: hilo.status },
        messages: pagina,
        // Compatibilidad: `siguiente` sigue siendo el cursor hacia adelante del contrato viejo.
        siguiente: haciaAdelante && hayMas ? recorte[recorte.length - 1].createdAt.toISOString() : null,
        // Hacia atrás: con qué pedir los mensajes ANTERIORES a los que vienen acá.
        anteriores: !haciaAdelante && hayMas && pagina.length ? pagina[0].createdAt.toISOString() : null,
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
