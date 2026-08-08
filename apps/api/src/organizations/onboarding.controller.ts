import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { templateGuideFor } from "./template-guide";

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
  constructor(private prisma: PrismaService) {}

  @Get()
  status() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [org, whatsappNumbers, templates, publishedAgents, publishedWorkflows, activeMembers] =
        await Promise.all([
          tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } }),
          tx.whatsappPhoneNumber.count({ where: { status: "active" } }),
          tx.whatsappTemplate.count(),
          tx.agentVersion.count({ where: { status: "PUBLISHED" } }),
          tx.workflowVersion.count({ where: { status: "PUBLISHED" } }),
          tx.organizationUser.count({ where: { active: true } }),
        ]);

      const settings = (org?.settings ?? {}) as Record<string, any>;
      const industry = String(settings.general?.industry ?? "");

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
}
