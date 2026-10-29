import type { AssistantAction } from "@conversia/types";
import type { CopilotTarget } from "./actions";

/**
 * COP ETAPA 1 — la parte DECIDIBLE del copiloto, sin base de datos.
 *
 * Todo lo que aquí se decide (a qué pantalla llevar, qué resaltar, qué camino de WhatsApp
 * recomendar, cómo entender un horario dictado a mano) se puede probar con entradas y
 * salidas, sin sim ni Postgres. Las herramientas de `setup-tools.ts` leen y escriben; esto
 * decide. La separación es lo que permite que el guion del montaje tenga tests de verdad.
 */

// ---------------------------------------------------------------------------
// Acompañar: a qué pantalla va cada paso del montaje y qué se resalta ahí
// ---------------------------------------------------------------------------

/**
 * Pantalla —y, cuando existe, el elemento— que corresponden a cada paso del checklist
 * único. `target` es OPCIONAL a propósito: hay pasos que no tienen un control que señalar,
 * como publicar el asistente (lo hace el copiloto con su herramienta) o la prueba real (la
 * hace el dueño desde otro teléfono). Inventar un `data-copilot` para esos casos era
 * prometer un resaltado que nunca iba a aparecer.
 */
const PASO_A_PANTALLA: Record<string, { to: string; target?: CopilotTarget; text?: string }> = {
  negocio: { to: "/ajustes", target: "negocio-datos", text: "Completa aquí el nombre, rubro y dirección de tu negocio." },
  servicios: { to: "/agenda/configurar", target: "servicios", text: "Agrega cada servicio con su precio y cuánto dura." },
  agenda: { to: "/agenda/configurar", target: "profesionales", text: "Suma al menos una persona con su horario semanal." },
  asistente: { to: "/inicio" },
  whatsapp: { to: "/canales", target: "conectar-whatsapp", text: "Conecta tu WhatsApp aquí; toma unos 3 minutos." },
  prueba: { to: "/conversaciones" },
  // §5 — el texto dice CUÁL tarjeta y por qué. "Deja tu tarjeta" no distingue, y con una de
  // débito el cobro automático no existe: el cliente queda creyendo que está cubierto y el
  // día que se le acaben los créditos su asistente se pausa. Este resaltado es el único
  // momento en que está mirando justo el control donde elige.
  pago: {
    to: "/cobros",
    target: "plan",
    text: "Activa tu plan y deja una tarjeta de CRÉDITO: con débito no se pueden hacer cobros automáticos y tu asistente se pausaría al quedarse sin créditos.",
  },
  mini_sitio: { to: "/mini-sitio" },
};

/**
 * Las acciones con que el copiloto ACOMPAÑA un paso: lo lleva a la pantalla y le señala
 * qué tocar. Si el cliente ya está en esa pantalla no lo volvemos a navegar (navegar a
 * donde ya estás parpadea la página por nada), pero el resaltado se mantiene: es lo que
 * contesta "¿y dónde?".
 */
export function accionesParaPaso(stepKey: string, rutaActual?: string): AssistantAction[] {
  const destino = PASO_A_PANTALLA[stepKey];
  if (!destino) return [];
  const yaEstoy = (rutaActual ?? "").split("?")[0] === destino.to;
  const acciones: AssistantAction[] = [];
  if (!yaEstoy) acciones.push({ type: "navigate", to: destino.to });
  if (destino.target && destino.text) acciones.push({ type: "highlight", target: destino.target, text: destino.text });
  return acciones;
}

/** ¿Este paso tiene una pantalla a la que acompañar? (`acompañarPaso` falla si no.) */
export function pasoConocido(stepKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(PASO_A_PANTALLA, stepKey);
}

/** ¿Este paso del montaje se completa con un clic del dueño que el copiloto no puede dar? */
export function pasoNecesitaClic(stepKey: string): "whatsapp" | "pago" | null {
  if (stepKey === "whatsapp") return "whatsapp";
  if (stepKey === "pago") return "pago";
  return null;
}

// ---------------------------------------------------------------------------
// WhatsApp: qué camino recomendar
// ---------------------------------------------------------------------------

export interface CanalFacts {
  /** Canales activos del tenant. */
  activos: number;
  /** Canales activos SIN agente asignado (conectados y mudos). */
  sinAgente: number;
  /** El dueño dijo que ya atiende por WhatsApp con su número. */
  yaAtiendePorWhatsapp: boolean;
  /** Último error de integración del canal, si hubo. */
  ultimoError: string | null;
}

export type CaminoWhatsapp = "coexistencia" | "numero_nuevo" | "asignar_agente" | "revisar_error" | "listo";

/**
 * Diagnóstico del canal. El orden de las reglas es el que importa:
 *
 *  1. Un canal conectado SIN agente es el peor estado posible y no se ve: el número recibe
 *     y nadie responde (hallazgo 2 de la auditoría). Va primero, antes que cualquier
 *     recomendación de conectar nada.
 *  2. Un error de integración se explica antes de proponer caminos nuevos: si Meta rechazó
 *     algo, conectar otra vez da el mismo error.
 *  3. Recién entonces se elige camino, y por defecto es COEXISTENCIA: conserva el número y
 *     los chats del dueño y normalmente no pide verificación del negocio.
 */
export function diagnosticarCanal(f: CanalFacts): CaminoWhatsapp {
  if (f.activos > 0 && f.sinAgente > 0) return "asignar_agente";
  if (f.activos === 0 && f.ultimoError) return "revisar_error";
  if (f.activos > 0) return "listo";
  return f.yaAtiendePorWhatsapp ? "coexistencia" : "numero_nuevo";
}

/** Texto para el dueño de cada diagnóstico (sin jerga: nada de "WABA" ni "defaultAgentId"). */
export function explicarCamino(camino: CaminoWhatsapp): string {
  switch (camino) {
    case "asignar_agente":
      return "Tu número está conectado pero no tiene asistente asignado, así que los mensajes llegan y nadie contesta. Lo asigno y queda andando.";
    case "revisar_error":
      return "El último intento de conexión falló. Te cuento qué pasó y lo resolvemos antes de volver a intentar.";
    case "listo":
      return "Tu WhatsApp ya está conectado con tu asistente atendiendo.";
    case "coexistencia":
      return "Como ya atiendes por WhatsApp, lo mejor es conectar ESE mismo número: mantienes tu teléfono y tus chats, no necesitas página web ni cuenta de Facebook, y tú puedes seguir respondiendo a mano cuando quieras.";
    case "numero_nuevo":
      return "Puedes conectar el número que ya usas (mantienes tus chats y es lo más rápido) o pedir un número nuevo dedicado. Si eliges uno nuevo, Meta puede pedirte verificar el negocio, que es un trámite suyo de una sola vez.";
  }
}

// ---------------------------------------------------------------------------
// Horario de atención: entender lo que el dueño dicta
// ---------------------------------------------------------------------------

export const DIAS_SEMANA = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];

const ALIAS_DIA: Record<string, DiaSemana> = {
  lun: "mon", lunes: "mon", mon: "mon", monday: "mon",
  mar: "tue", martes: "tue", tue: "tue", tuesday: "tue",
  mie: "wed", mié: "wed", miercoles: "wed", miércoles: "wed", wed: "wed", wednesday: "wed",
  jue: "thu", jueves: "thu", thu: "thu", thursday: "thu",
  vie: "fri", viernes: "fri", fri: "fri", friday: "fri",
  sab: "sat", sáb: "sat", sabado: "sat", sábado: "sat", sat: "sat", saturday: "sat",
  dom: "sun", domingo: "sun", sun: "sun", sunday: "sun",
};

/** Normaliza el nombre de un día a la clave que guarda la organización. `null` si no se entiende. */
export function normalizarDia(input: string): DiaSemana | null {
  const k = input.trim().toLowerCase().replace(/\.$/, "");
  return ALIAS_DIA[k] ?? null;
}

/**
 * Normaliza una hora a `HH:MM`. Acepta lo que el dueño dice de verdad: "9", "9:00", "09.00",
 * "18", "6pm". Devuelve `null` si no es una hora del día — y eso incluye "25:00", porque un
 * horario inválido guardado es un bot que ofrece horas que no existen.
 */
export function normalizarHora(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const pm = /pm$/.test(s);
  const am = /am$/.test(s);
  const limpio = s.replace(/[ap]m$/, "");
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?$/.exec(limpio);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export interface TramoEntrada { dia: string; desde: string; hasta: string }

/**
 * Convierte los tramos que dicta el dueño en el formato que guarda la organización
 * (`settings.businessHours.hours = { mon: [{from,to}] }`). Descarta lo que no se entiende
 * y lo informa, en vez de guardar medio horario en silencio: un horario incompleto hace
 * que el bot diga "no hay horas" en días que sí abren.
 */
export function construirHorario(tramos: TramoEntrada[]): {
  hours: Record<string, { from: string; to: string }[]>;
  descartados: string[];
} {
  const hours: Record<string, { from: string; to: string }[]> = {};
  const descartados: string[] = [];
  for (const t of tramos) {
    const dia = normalizarDia(String(t?.dia ?? ""));
    const from = normalizarHora(String(t?.desde ?? ""));
    const to = normalizarHora(String(t?.hasta ?? ""));
    if (!dia || !from || !to) {
      descartados.push(`${t?.dia ?? "?"} ${t?.desde ?? "?"}-${t?.hasta ?? "?"}`);
      continue;
    }
    if (from >= to) {
      // Un tramo que cierra antes de abrir es un error de dictado, no un turno de noche:
      // guardarlo deja el día sin disponibilidad real.
      descartados.push(`${t.dia} ${from}-${to} (cierra antes de abrir)`);
      continue;
    }
    const lista = (hours[dia] ??= []);
    if (lista.length >= 4) {
      descartados.push(`${t.dia} ${from}-${to} (más de 4 tramos en el día)`);
      continue;
    }
    if (lista.some((x) => x.from === from && x.to === to)) continue;
    lista.push({ from, to });
  }
  for (const dia of Object.keys(hours)) hours[dia].sort((a, b) => a.from.localeCompare(b.from));
  return { hours, descartados };
}

/** Resumen legible del horario guardado, para confirmarle al dueño lo que quedó. */
export function resumirHorario(hours: Record<string, { from: string; to: string }[]>): string {
  const nombre: Record<string, string> = { mon: "lun", tue: "mar", wed: "mié", thu: "jue", fri: "vie", sat: "sáb", sun: "dom" };
  const partes = DIAS_SEMANA.filter((d) => (hours[d] ?? []).length > 0).map(
    (d) => `${nombre[d]} ${hours[d].map((t) => `${t.from}-${t.to}`).join(" y ")}`,
  );
  return partes.length ? partes.join(" · ") : "sin horario";
}
