import type { PrismaService } from "../prisma.service";
import { resolvePersonalization } from "../common/industries";

/**
 * ETAPA 0 — CHECKLIST ÚNICO DE MONTAJE (fuente de verdad).
 *
 * Antes había DOS checklists que no coincidían (hallazgo 4 de la auditoría 26/27-oct):
 * `buildContext` del asistente tenía 4 pasos y daba el agente por listo con que EXISTIERA,
 * y `GET /onboarding` tenía 7 pasos con CTAs a rutas de TuBot (`/channels`, `/billing`,
 * `/agents`, `/settings/users`) que NO existen en conversia-web. Resultado: el cliente veía
 * un avance que no correspondía y los botones lo llevaban a un 404.
 *
 * Aquí vive UN solo cálculo, con la condición REAL de "hecho" de cada paso, reutilizado por
 * `/assistant/context` (el copiloto) y por `GET /onboarding` **cuando la marca es conversia**.
 * Para `brand=tubot` el controlador sigue respondiendo EXACTAMENTE lo de antes (TuBot intacto).
 *
 * Reglas del módulo:
 * - `href` SIEMPRE una ruta que existe en `apps/conversia-web/src/app` (lo verifica
 *   `setup-checklist-routes.spec.ts`, que recorre el árbol real de páginas).
 * - El PORCENTAJE cuenta solo los pasos BLOQUEANTES: los opcionales (mini-sitio, equipo,
 *   PWA, notificaciones, correo) no pueden impedir el 100% de "bot activo y pagado".
 * - El cálculo es puro (`buildSetupSteps`) y la lectura de BD va aparte (`readSetupFacts`),
 *   para poder testear los pasos sin base de datos.
 * - Sin migraciones: todo sale de tablas y de `organization.settings` que ya existen.
 */

/** Un paso del montaje. Trae el contrato NUEVO (label/blocking/href) y el VIEJO de `/onboarding`. */
export interface SetupChecklistStep {
  key: string;
  /** Texto corto en español, para el cliente. */
  label: string;
  done: boolean;
  /** false = opcional: no entra en el porcentaje ni impide el 100%. */
  blocking: boolean;
  /** Ruta REAL de conversia-web a la que se manda al cliente. */
  href: string;
  /**
   * COP 2 — minutos estimados del paso, para la barra de progreso del copiloto
   * ("Paso 3 de 7 · faltan ~4 min"). Estiman el tiempo REAL de la tarea, no el de un clic:
   * conectar WhatsApp pasa por el diálogo de Meta y la prueba depende de que el dueño
   * agarre otro teléfono. Mejor quedarse corto en la promesa: decirle "2 min" a algo que
   * toma 6 es peor que no decir nada.
   */
  minutes: number;
  // --- Compatibilidad: `GET /onboarding` ya devolvía esta forma y la UI la consume
  // (apps/conversia-web/src/app/canales/page.tsx lee steps[].key/.done). Superset, no reemplazo.
  title: string;
  description: string;
  cta: { label: string; href: string };
}

/**
 * Hechos del tenant que deciden cada paso. Se leen una sola vez de la BD
 * (`readSetupFacts`) y se transforman en pasos sin volver a consultar (`buildSetupSteps`).
 */
export interface SetupFacts {
  /** Nombre del negocio cargado (no vacío). */
  hasBusinessName: boolean;
  /** Rubro elegido (`settings.general.industry`). */
  hasIndustry: boolean;
  /** Dirección/comuna (del negocio o del mini-sitio). */
  hasAddress: boolean;
  /** Horario de atención (`settings.businessHours.hours` o el texto del mini-sitio). */
  hasBusinessHours: boolean;
  /** Servicios ACTIVOS con precio Y duración (no basta el nombre). */
  servicesPriced: number;
  /** El rubro agenda citas (`modules.agenda`): si no, el paso de agenda no aplica. */
  agendaModule: boolean;
  /** Profesionales activos con horario semanal cargado (`meta.workingHours`). */
  professionalsWithHours: number;
  /** Agentes con una versión PUBLICADA (un borrador NO cuenta). */
  publishedAgents: number;
  /** Hay un canal/número de WhatsApp activo. */
  whatsappConnected: boolean;
  /** Canales activos CON `defaultAgentId`: sin esto nadie responde en el número. */
  channelsWithAgent: number;
  /** El bot ya respondió al menos un mensaje real (OUTBOUND de autor AGENT). */
  botReplied: boolean;
  /** Suscripción ACTIVE (plan activado, ya no prueba). */
  planActive: boolean;
  /** Tarjeta guardada o una factura pagada (ya demostró poder pagar). */
  hasPaymentMethod: boolean;
  // ---- Opcionales (no bloquean el 100%) ----
  miniSiteEnabled: boolean;
  /** Miembros activos de la organización (>1 = invitó a alguien). */
  teamMembers: number;
  pwaInstalled: boolean;
  pushDevices: number;
  emailVerified: boolean;
}

/** Org recién nacida: nada hecho. Útil como base en tests y como degradado seguro. */
export const EMPTY_SETUP_FACTS: SetupFacts = {
  hasBusinessName: false,
  hasIndustry: false,
  hasAddress: false,
  hasBusinessHours: false,
  servicesPriced: 0,
  agendaModule: true,
  professionalsWithHours: 0,
  publishedAgents: 0,
  whatsappConnected: false,
  channelsWithAgent: 0,
  botReplied: false,
  planActive: false,
  hasPaymentMethod: false,
  miniSiteEnabled: false,
  teamMembers: 1,
  pwaInstalled: false,
  pushDevices: 0,
  emailVerified: false,
};

/** Arma el paso completando el contrato viejo de `/onboarding` desde el nuevo. */
function step(s: {
  key: string;
  label: string;
  description: string;
  ctaLabel: string;
  href: string;
  done: boolean;
  blocking: boolean;
  minutes: number;
}): SetupChecklistStep {
  return {
    key: s.key,
    label: s.label,
    done: s.done,
    blocking: s.blocking,
    href: s.href,
    minutes: s.minutes,
    title: s.label,
    description: s.description,
    cta: { label: s.ctaLabel, href: s.href },
  };
}

/**
 * Los 8 puntos de la Etapa 0, en orden, con su condición REAL de "hecho". PURO: mismas
 * entradas → mismas salidas, sin BD. El paso de agenda se OMITE si el rubro no agenda citas
 * (un comercio no debería quedar en 86% para siempre por no tener profesionales).
 */
export function buildSetupSteps(facts: SetupFacts): SetupChecklistStep[] {
  const steps: SetupChecklistStep[] = [
    step({
      key: "negocio",
      label: "Completa los datos de tu negocio",
      description: "Nombre, rubro, dirección y horario de atención: con esto tu asistente responde bien desde el primer mensaje.",
      ctaLabel: "Completar datos",
      href: "/ajustes",
      done: facts.hasBusinessName && facts.hasIndustry && facts.hasAddress && facts.hasBusinessHours,
      minutes: 3,
      blocking: true,
    }),
    step({
      key: "servicios",
      label: "Carga tus servicios con precio y duración",
      description: "Tu asistente necesita saber qué ofreces, cuánto cuesta y cuánto dura para poder cotizar y agendar.",
      ctaLabel: "Cargar servicios",
      href: "/agenda/configurar",
      done: facts.servicesPriced > 0,
      minutes: 4,
      blocking: true,
    }),
  ];

  // Solo si el rubro agenda citas (modules.agenda): un comercio/pedidos no necesita agenda.
  if (facts.agendaModule) {
    steps.push(
      step({
        key: "agenda",
        label: "Agrega un profesional con su horario",
        description: "Para que el asistente ofrezca horas reales necesita al menos una persona (o recurso) con su horario semanal.",
        ctaLabel: "Configurar agenda",
        href: "/agenda/configurar",
        done: facts.professionalsWithHours > 0,
        minutes: 3,
        blocking: true,
      }),
    );
  }

  steps.push(
    step({
      key: "asistente",
      label: "Personaliza y publica tu asistente",
      description: "No basta con que exista: hay que publicarlo para que atienda. Un asistente en borrador no responde a nadie.",
      ctaLabel: "Publicar mi asistente",
      href: "/inicio",
      done: facts.publishedAgents > 0,
      minutes: 3,
      blocking: true,
    }),
    step({
      key: "whatsapp",
      label: "Conecta tu WhatsApp y asígnale el asistente",
      description: "Conectar el número no alcanza: el canal tiene que quedar con tu asistente asignado, o nadie responde ahí.",
      ctaLabel: "Conectar WhatsApp",
      href: "/canales",
      done: facts.whatsappConnected && facts.channelsWithAgent > 0,
      minutes: 4,
      blocking: true,
    }),
    step({
      key: "prueba",
      label: "Haz la prueba real: que tu bot responda",
      description: "Escríbele desde otro teléfono. El paso queda listo cuando tu asistente contestó al menos un mensaje de verdad.",
      ctaLabel: "Ver la conversación",
      href: "/conversaciones",
      done: facts.botReplied,
      minutes: 2,
      blocking: true,
    }),
    step({
      key: "pago",
      label: "Activa tu plan o carga tu método de pago",
      description: "Así tu asistente no se corta cuando se acaben las conversaciones de prueba.",
      ctaLabel: "Activar mi plan",
      href: "/cobros",
      done: facts.planActive || facts.hasPaymentMethod,
      minutes: 2,
      blocking: true,
    }),
    // ---- Opcionales: suman, pero JAMÁS impiden llegar al 100% ----
    step({
      key: "mini_sitio",
      label: "Publica tu mini-sitio",
      description: "Una página simple de tu negocio, con tus servicios y tu WhatsApp, lista para compartir.",
      ctaLabel: "Ver mi página",
      href: "/mini-sitio",
      done: facts.miniSiteEnabled,
      minutes: 1,
      blocking: false,
    }),
    step({
      key: "equipo",
      label: "Invita a tu equipo",
      description: "Suma a quienes atenderán conversaciones contigo desde la Bandeja.",
      ctaLabel: "Invitar equipo",
      href: "/ajustes",
      done: facts.teamMembers > 1,
      minutes: 2,
      blocking: false,
    }),
    step({
      key: "pwa",
      label: "Instala la app en tu teléfono",
      description: "Conversia se instala como app: entras más rápido y recibes los avisos como cualquier otra.",
      ctaLabel: "Cómo instalarla",
      href: "/ajustes",
      done: facts.pwaInstalled,
      minutes: 1,
      blocking: false,
    }),
    step({
      key: "notificaciones",
      label: "Activa las notificaciones",
      description: "Te avisamos cuando alguien espera respuesta, cuando entra una cita y cuando baja tu saldo.",
      ctaLabel: "Activar avisos",
      href: "/ajustes",
      done: facts.pushDevices > 0,
      minutes: 1,
      blocking: false,
    }),
    step({
      key: "correo",
      label: "Verifica tu correo",
      description: "Confirma tu correo para recuperar la cuenta y recibir los comprobantes.",
      ctaLabel: "Reenviar verificación",
      href: "/inicio",
      done: facts.emailVerified,
      minutes: 1,
      blocking: false,
    }),
  );

  return steps;
}

/** Resumen del montaje. `percent`/`done` cuentan SOLO los pasos bloqueantes. */
export interface SetupChecklist {
  steps: SetupChecklistStep[];
  /** Pasos hechos (incluye opcionales) — compatibilidad con el contrato de `/onboarding`. */
  completed: number;
  total: number;
  /** Avance real del montaje: solo pasos bloqueantes. */
  percent: number;
  /** true = "bot activo y pagado": todos los bloqueantes hechos. */
  done: boolean;
  blockingCompleted: number;
  blockingTotal: number;
  /** Siguiente paso BLOQUEANTE pendiente (lo que el copiloto propone hacer). */
  nextStep: SetupChecklistStep | null;
  /** COP 2 — minutos estimados de lo que FALTA (solo bloqueantes). 0 si ya está todo. */
  remainingMinutes: number;
}

export function summarizeSetupChecklist(steps: SetupChecklistStep[]): SetupChecklist {
  const blocking = steps.filter((s) => s.blocking);
  const blockingCompleted = blocking.filter((s) => s.done).length;
  const blockingTotal = blocking.length;
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    percent: blockingTotal ? Math.round((blockingCompleted / blockingTotal) * 100) : 100,
    done: blockingCompleted === blockingTotal,
    blockingCompleted,
    blockingTotal,
    nextStep: blocking.find((s) => !s.done) ?? null,
    // Solo lo que falta y solo lo bloqueante: los pasos opcionales no entran en la promesa
    // de "faltan ~N min" para dejar el bot andando.
    remainingMinutes: blocking.filter((s) => !s.done).reduce((t, s) => t + s.minutes, 0),
  };
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/** ¿El horario de la org tiene al menos un tramo? (`settings.businessHours.hours` = {mon:[…]}). */
function hasAnyInterval(hours: unknown): boolean {
  if (!hours || typeof hours !== "object") return false;
  return Object.values(hours as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
}

/** ¿El profesional tiene horario semanal? (`meta.workingHours = [{day,start,end}]`). */
function hasWorkingHours(meta: unknown): boolean {
  const wh = (meta as { workingHours?: unknown } | null)?.workingHours;
  return Array.isArray(wh) && wh.length > 0;
}

export interface SetupChecklistOptions {
  /** Usuario que mira (del JWT): decide de quién se comprueba el correo verificado. */
  userId?: string | null;
  /** Organización YA leída por el caller (evita una segunda consulta a la misma fila). */
  org?: { name?: string | null; settings?: unknown } | null;
}

/**
 * Lee de la BD los hechos del tenant. El `organizationId` SIEMPRE viene del JWT del caller
 * (nunca del cliente ni del modelo). Usa el cliente admin acotado por `organizationId` en
 * cada `where` — igual que `buildContext` — y cada consulta accesoria degrada a su valor
 * neutro: así una tabla aún no migrada no tumba el checklist completo (regla de
 * `withTenant` = transacción: un error de BD dentro de la tx la aborta entera).
 *
 * La consulta de la organización va SIN red de seguridad a propósito: si la BD está caída de
 * verdad, el caller tiene que enterarse y degradar él (`AssistantService.run` ya lo hace con
 * `minimalContext`). Si el caller ya la leyó, la pasa en `opts.org` y no se repite.
 */
export async function readSetupFacts(
  prisma: Pick<PrismaService, "admin">,
  organizationId: string,
  opts: SetupChecklistOptions = {},
): Promise<SetupFacts> {
  const admin = prisma.admin;
  const userId = opts.userId;
  const org =
    opts.org !== undefined
      ? opts.org
      : await admin.organization.findUnique({ where: { id: organizationId }, select: { name: true, settings: true } });
  const settings = (org?.settings ?? {}) as Record<string, any>;
  const general = (settings.general ?? {}) as Record<string, any>;
  const business = (settings.business ?? {}) as Record<string, any>;
  const miniSite = (settings.miniSite ?? {}) as Record<string, any>;
  const businessHours = (settings.businessHours ?? {}) as Record<string, any>;

  const [
    servicesPriced,
    professionalsWithHours,
    publishedAgents,
    activeChannels,
    channelsWithAgent,
    waNumbers,
    botReply,
    activeSub,
    paymentMethods,
    paidInvoices,
    teamMembers,
    pwaEvent,
    pushDevices,
    verifiedUsers,
  ] = await Promise.all([
    // Servicio "cargado" = activo, CON precio y CON duración (el nombre solo no sirve al bot).
    admin.service.count({ where: { organizationId, active: true, price: { not: null }, durationMin: { gt: 0 } } }).catch(() => 0),
    // El horario vive en meta.workingHours (JSON): se filtra en memoria, no en SQL.
    admin.professional
      .findMany({ where: { organizationId, active: true }, select: { meta: true }, take: 100 })
      .then((rows: { meta: unknown }[]) => rows.filter((p) => hasWorkingHours(p.meta)).length)
      .catch(() => 0),
    // PUBLICADO: un borrador no atiende a nadie (hallazgo 1 de la auditoría).
    admin.agentVersion.count({ where: { organizationId, status: "PUBLISHED", agent: { deletedAt: null, active: true } } }).catch(() => 0),
    admin.channelConnection.count({ where: { organizationId, status: "active" } }).catch(() => 0),
    // CON agente asignado: sin defaultAgentId el número queda conectado y mudo (hallazgo 2).
    admin.channelConnection.count({ where: { organizationId, status: "active", defaultAgentId: { not: null } } }).catch(() => 0),
    admin.whatsappPhoneNumber.count({ where: { organizationId, status: "active" } }).catch(() => 0),
    // Prueba real: un mensaje SALIENTE escrito por el AGENTE (no por una persona del equipo).
    admin.message.findFirst({ where: { organizationId, direction: "OUTBOUND", authorType: "AGENT" }, select: { id: true } }).catch(() => null),
    admin.subscription.findFirst({ where: { organizationId, status: "ACTIVE" }, select: { id: true } }).catch(() => null),
    admin.paymentMethod.count({ where: { organizationId } }).catch(() => 0),
    admin.invoice.count({ where: { organizationId, status: "PAID" } }).catch(() => 0),
    admin.organizationUser.count({ where: { organizationId, active: true } }).catch(() => 0),
    admin.auditLog.findFirst({ where: { organizationId, action: "pwa.installed" }, select: { id: true } }).catch(() => null),
    admin.pushDevice.count({ where: { organizationId, active: true } }).catch(() => 0),
    // El correo es del USUARIO, no de la org: si sabemos quién mira, preguntamos por él.
    admin.organizationUser
      .count({
        where: {
          organizationId,
          active: true,
          ...(userId ? { userId } : {}),
          user: { emailVerifiedAt: { not: null } },
        },
      })
      .catch(() => 0),
  ]);

  return {
    hasBusinessName: nonEmpty(org?.name),
    hasIndustry: nonEmpty(general.industry),
    hasAddress: nonEmpty(business.direccion) || nonEmpty(business.address) || nonEmpty(miniSite.address) || nonEmpty(general.address),
    hasBusinessHours: hasAnyInterval(businessHours.hours) || nonEmpty(miniSite.hours),
    servicesPriced,
    agendaModule: resolvePersonalization(settings).modules.agenda !== false,
    professionalsWithHours,
    publishedAgents,
    whatsappConnected: activeChannels > 0 || waNumbers > 0,
    channelsWithAgent,
    botReplied: !!botReply,
    planActive: !!activeSub,
    hasPaymentMethod: paymentMethods > 0 || paidInvoices > 0,
    miniSiteEnabled: miniSite.enabled === true,
    teamMembers,
    pwaInstalled: !!pwaEvent,
    pushDevices,
    emailVerified: verifiedUsers > 0,
  };
}

/** Checklist completo del tenant: lee los hechos y los convierte en pasos + avance. */
export async function getSetupChecklist(
  prisma: Pick<PrismaService, "admin">,
  organizationId: string,
  opts: SetupChecklistOptions = {},
): Promise<SetupChecklist> {
  return summarizeSetupChecklist(buildSetupSteps(await readSetupFacts(prisma, organizationId, opts)));
}
