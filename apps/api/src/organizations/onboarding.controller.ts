import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { getSetupChecklist } from "../onboarding/setup-checklist";
import { requireContext } from "../tenancy/context";
import { templateGuideFor } from "./template-guide";
import { VerticalService } from "./vertical.service";

/** Un paso del checklist de puesta en marcha, con su estado y su llamada a la acción. */
export interface OnboardingStep {
  key: string;
  title: string;
  description: string;
  done: boolean;
  cta: { label: string; href: string };
}

/**
 * Checklist de activación del cliente nuevo. Lee el ESTADO REAL del tenant (no
 * un flag manual): canal de WhatsApp, plantillas instaladas, primer agente
 * publicado, primer flujo publicado y equipo invitado. Con esto el panel muestra
 * el progreso y guía el primer día, que es lo que convierte al lead en cliente.
 */
@Controller("onboarding")
export class OnboardingController {
  constructor(
    private prisma: PrismaService,
    private vertical: VerticalService,
  ) {}

  /**
   * ETAPA 0 — una sola fuente de verdad del montaje, pero SOLO para Conversia.
   *
   * `brand=conversia` → `getSetupChecklist` (los 8 puntos de la Etapa 0, con `href` a rutas
   * reales de conversia-web y el porcentaje contando solo los bloqueantes). La forma que ya
   * devolvíamos (`steps[].key/title/description/done/cta` + `completed/total/percent/done`)
   * se mantiene como superset, así que `canales/page.tsx` sigue funcionando igual.
   *
   * Cualquier otra marca (TuBot) → `legacyStatus`, BYTE POR BYTE lo de hoy: su panel
   * (`apps/web`: página "Primeros pasos" + OnboardingBanner) depende de esos 7 pasos y de
   * sus CTAs (`/channels`, `/billing`, `/agents`, `/settings/users`), que allá SÍ existen.
   * Si la lectura de la marca falla, caemos a TuBot (fail-safe: nunca cambiamos lo que ya
   * funciona en producción).
   */
  @Get()
  async status() {
    const ctx = requireContext();
    const org = await this.prisma.admin.organization
      .findUnique({ where: { id: ctx.organizationId }, select: { brand: true, name: true, settings: true } })
      .catch(() => null);
    const brand = (org?.brand ?? "tubot").toLowerCase();
    if (brand === "conversia") {
      // Reusamos la fila ya leída (nombre + settings): el checklist no vuelve a consultarla.
      return getSetupChecklist(this.prisma, ctx.organizationId, { userId: ctx.userId, org });
    }
    return this.legacyStatus(ctx.organizationId);
  }

  /** Checklist histórico de TuBot. NO TOCAR: es el contrato que consume `apps/web`. */
  private legacyStatus(organizationId: string) {
    return this.prisma.withTenant(organizationId, async (tx) => {
      const [org, whatsappNumbers, templates, publishedAgents, publishedWorkflows, activeMembers, paymentMethods, paidInvoices] =
        await Promise.all([
          tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } }),
          tx.whatsappPhoneNumber.count({ where: { status: "active" } }),
          tx.whatsappTemplate.count(),
          tx.agentVersion.count({ where: { status: "PUBLISHED" } }),
          tx.workflowVersion.count({ where: { status: "PUBLISHED" } }),
          tx.organizationUser.count({ where: { active: true } }),
          tx.paymentMethod.count(),
          tx.invoice.count({ where: { status: "PAID" } }),
        ]);

      const settings = (org?.settings ?? {}) as Record<string, any>;
      const industry = String(settings.general?.industry ?? "");
      const hasVertical = !!settings.vertical?.key;

      const steps: OnboardingStep[] = [
        {
          key: "whatsapp",
          title: "Conectar WhatsApp",
          description: "Vincula tu número de WhatsApp Business para empezar a recibir y responder mensajes.",
          done: whatsappNumbers > 0,
          cta: { label: "Conectar WhatsApp", href: "/channels" },
        },
        {
          key: "templates",
          title: "Elegir tu rubro e instalar plantillas",
          description: "Define tu rubro y crea en Meta las plantillas que tu negocio necesita para iniciar conversaciones.",
          done: !!industry && templates > 0,
          cta: { label: "Ver plantillas de mi rubro", href: "/onboarding/plantillas" },
        },
        {
          key: "vertical",
          title: "Instalar el paquete de tu rubro",
          description: "Instala el paquete vertical (etapas, servicios, agentes y flujos base) para arrancar con todo listo para personalizar.",
          done: hasVertical,
          cta: { label: "Instalar paquete de rubro", href: "/onboarding" },
        },
        {
          // Pedido del negocio (sim 200, 2026-10-17): el flujo de implementación debe
          // pedir el método de pago ANTES de que se acaben los créditos del período,
          // para que la recarga/renovación no corte al bot. Done = tarjeta guardada
          // o al menos una factura pagada (ya demostró poder pagar).
          key: "pago",
          title: "Cargar tu método de pago",
          description: "Registra una tarjeta (o paga tu primer período) para que tu plan y tus recargas se renueven solos y el bot nunca se detenga por saldo.",
          done: paymentMethods > 0 || paidInvoices > 0,
          cta: { label: "Agregar método de pago", href: "/billing" },
        },
        {
          key: "agent",
          title: "Crear y publicar tu primer agente",
          description: "Configura el agente de IA que atenderá a tus contactos y publícalo para dejarlo activo.",
          done: publishedAgents > 0,
          cta: { label: "Crear agente", href: "/agents" },
        },
        {
          key: "workflow",
          title: "Publicar tu primer flujo",
          description: "Arma un flujo automatizado (bienvenida, agenda, seguimiento…) y publícalo.",
          done: publishedWorkflows > 0,
          cta: { label: "Crear flujo", href: "/workflows" },
        },
        {
          key: "team",
          title: "Invitar a tu equipo",
          description: "Suma a las personas que atenderán conversaciones desde la Bandeja.",
          done: activeMembers > 1,
          cta: { label: "Invitar equipo", href: "/settings/users" },
        },
      ];

      const completed = steps.filter((s) => s.done).length;
      return {
        steps,
        completed,
        total: steps.length,
        percent: Math.round((completed / steps.length) * 100),
        done: completed === steps.length,
      };
    });
  }

  /**
   * Guía de plantillas por rubro: qué plantillas conviene tener, con el texto listo
   * para copiar a Meta y el estado de sincronización de cada una (comparando el
   * nombre sugerido con las plantillas ya existentes del tenant).
   */
  @Get("plantillas")
  templates() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [org, existing, hasWaba] = await Promise.all([
        tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } }),
        tx.whatsappTemplate.findMany({ select: { name: true, status: true, language: true } }),
        tx.whatsappAccount.count(),
      ]);
      const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t.status]));
      const suggestions = templateGuideFor((org?.settings ?? {}) as Record<string, any>).map((t) => ({
        ...t,
        // Estado de sync frente a Meta: not_created | PENDING | APPROVED | REJECTED…
        syncStatus: byName.get(t.name.toLowerCase()) ?? "not_created",
      }));
      return { suggestions, whatsappConnected: hasWaba > 0 };
    });
  }

  /** Instala el paquete vertical del rubro indicado en el tenant actual (idempotente). */
  @Post("vertical")
  async installVertical(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ key: z.string().trim().min(2).max(40) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Falta el rubro (key) del paquete a instalar.");
    const result = await this.vertical.install(ctx.organizationId, parsed.data.key, { source: "tenant" });
    return { ok: true, ...result };
  }

  /** Canales del tenant para SU pantalla: conexiones reales + los configurados (intents). */
  @Get("channels")
  async channels() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [org, connections] = await Promise.all([
        tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } }),
        tx.channelConnection.findMany({ select: { id: true, type: true, name: true, status: true } }),
      ]);
      const intents = (((org?.settings as Record<string, any>) ?? {}).channels ?? []) as { type: string; status: string }[];
      return { connections, intents };
    });
  }
}
