/**
 * COP 2 — "Convi": el copiloto como PERSONAJE, no como burbuja olvidada.
 *
 * Acá vive todo lo que se puede decidir con datos: cómo se llama, qué cara pone, qué
 * sugiere según el paso pendiente, qué avisa cuando el montaje ya terminó y cuándo le toca
 * ofrecer ayuda sin que le pregunten. El componente dibuja; esto decide, y por eso tiene
 * tests.
 */

/** Nombre del copiloto. Constante de marca: el dueño puede cambiarlo sin tocar la UI. */
export const CONVI_NAME = "Convi";

export type ConviEstado = "saludando" | "pensando" | "hablando" | "celebrando" | "preocupado";

export interface ConviCtx {
  mode: "implementacion" | "asistencia";
  checklistPct: number;
  blockingCompleted: number;
  blockingTotal: number;
  remainingMinutes: number;
  nextStep: { key: string; label: string; href: string } | null;
  saldo: string | null;
  saldoRestante: number | null;
  saldoUnidad: "conversation" | "credit" | null;
  lastChannelError: string | null;
  citasPorConfirmar: number;
  businessName?: string;
}

/**
 * La cara de Convi. El orden importa: un error se muestra por encima de todo lo demás
 * (si algo falló, Convi no puede estar celebrando), y "pensando" gana a "hablando" porque
 * mientras espera la respuesta todavía no dijo nada.
 */
export function estadoDeConvi(s: {
  error?: boolean;
  celebrando?: boolean;
  pensando?: boolean;
  conversacionEmpezada?: boolean;
}): ConviEstado {
  if (s.error) return "preocupado";
  if (s.pensando) return "pensando";
  if (s.celebrando) return "celebrando";
  return s.conversacionEmpezada ? "hablando" : "saludando";
}

/** "Paso 3 de 7 · faltan ~4 min". Sin los minutos si ya no falta nada medible. */
export function textoDeProgreso(c: Pick<ConviCtx, "blockingCompleted" | "blockingTotal" | "remainingMinutes">): string {
  if (!c.blockingTotal) return "Preparando tu montaje…";
  if (c.blockingCompleted >= c.blockingTotal) return "Montaje completo ✔";
  // El paso "en curso" es el siguiente pendiente: si van 2 de 7, está en el 3.
  const paso = Math.min(c.blockingCompleted + 1, c.blockingTotal);
  const mins = c.remainingMinutes > 0 ? ` · faltan ~${c.remainingMinutes} min` : "";
  return `Paso ${paso} de ${c.blockingTotal}${mins}`;
}

/** Saludo de la primera apertura. Usa el nombre del negocio si lo sabemos. */
export function saludoDeConvi(c: ConviCtx): string {
  const nombre = c.businessName && c.businessName !== "tu negocio" ? c.businessName : null;
  if (c.mode === "asistencia") {
    return nombre
      ? `¡Hola! Soy ${CONVI_NAME}. El asistente de ${nombre} ya está atendiendo. ¿En qué te ayudo?`
      : `¡Hola! Soy ${CONVI_NAME}. Tu asistente ya está atendiendo. ¿En qué te ayudo?`;
  }
  const presentacion = nombre
    ? `¡Hola! Soy ${CONVI_NAME} y te acompaño a dejar andando el asistente de ${nombre}.`
    : `¡Hola! Soy ${CONVI_NAME} y te acompaño a dejar tu asistente andando.`;
  if (c.nextStep) return `${presentacion} Lo que sigue es **${c.nextStep.label.toLowerCase()}**. ¿Lo hacemos ahora?`;
  return `${presentacion} ¿Empezamos?`;
}

/**
 * Chips sugeridos SEGÚN EL PASO PENDIENTE (no una lista fija). La idea es que lo primero
 * que vea el dueño sea lo que le toca, no un menú genérico.
 */
const CHIPS_POR_PASO: Record<string, string[]> = {
  negocio: ["Completa los datos de mi negocio", "Mi horario es de lunes a viernes de 9 a 18"],
  servicios: ["Ayúdame a cargar mis servicios con precio", "¿Qué datos necesitas de cada servicio?"],
  agenda: ["Agrega a alguien que atiende con su horario", "¿Cómo se ofrecen las horas?"],
  asistente: ["Arma mi asistente", "Pruébalo con un cliente de ejemplo"],
  whatsapp: ["Quiero conectar el WhatsApp que ya uso", "¿Pierdo mis chats si lo conecto?"],
  prueba: ["¿Cómo pruebo que mi bot responde?", "No me respondió, ¿qué reviso?"],
  pago: ["¿Cuánto cuesta el plan?", "Quiero activar mi plan"],
};

const CHIPS_ASISTENCIA = ["¿Cuánto saldo me queda?", "Cambiar el precio de un servicio", "Hablar con una persona"];

export function chipsSugeridos(c: ConviCtx): string[] {
  if (c.mode === "asistencia") return CHIPS_ASISTENCIA;
  const delPaso = c.nextStep ? CHIPS_POR_PASO[c.nextStep.key] : undefined;
  // Siempre dejamos la salida a "qué me falta": es la pregunta que hace todo el mundo.
  return [...(delPaso ?? []), "¿Qué me falta para activarlo?"].slice(0, 3);
}

export interface AvisoProactivo {
  /** Clave estable, para no repetir el mismo aviso dos veces en la sesión. */
  key: string;
  texto: string;
  urgente: boolean;
}

/**
 * Lo que Convi avisa SIN que le pregunten cuando el montaje ya terminó. Ordenado por lo que
 * le cuesta plata al dueño: quedarse sin saldo corta el bot, el canal caído lo deja mudo, y
 * las citas sin confirmar se vuelven no-shows.
 *
 * El umbral de saldo bajo va sobre el NÚMERO que manda el servidor, no sobre la frase: con
 * dos unidades de cobro (conversaciones y créditos) parsear el texto se rompía al cambiar
 * una palabra. El umbral es distinto por unidad porque un crédito no es una conversación:
 * una respuesta puede costar varios créditos.
 */
export function avisosProactivos(c: ConviCtx): AvisoProactivo[] {
  const out: AvisoProactivo[] = [];
  if (c.saldoRestante != null && c.saldoUnidad) {
    const umbral = c.saldoUnidad === "credit" ? 100 : 20;
    if (c.saldoRestante <= 0) {
      out.push({ key: "saldo-0", texto: "Te quedaste sin saldo: tu asistente dejó de responder. Puedo mostrarte cómo recargar.", urgente: true });
    } else if (c.saldoRestante <= umbral) {
      out.push({ key: "saldo-bajo", texto: `Te queda poco saldo (${c.saldo}). Mejor recargar antes de que se corte.`, urgente: true });
    }
  }
  if (c.lastChannelError) {
    out.push({ key: "canal", texto: "Hubo un problema con tu WhatsApp. ¿Lo reviso contigo?", urgente: true });
  }
  if (c.citasPorConfirmar > 0) {
    out.push({
      key: "citas",
      texto: c.citasPorConfirmar === 1 ? "Tienes 1 cita por confirmar en las próximas 48 horas." : `Tienes ${c.citasPorConfirmar} citas por confirmar en las próximas 48 horas.`,
      urgente: false,
    });
  }
  return out;
}

/**
 * ¿Convi se abre solo? Solo en MODO MONTAJE y solo UNA vez por sesión del navegador: un
 * panel que se abre en cada navegación es una molestia, no un acompañamiento. Si el dueño
 * lo cerró, no vuelve a abrirse solo (queda el acceso con su progreso).
 */
export function debeAbrirseSolo(s: { mode: string; yaSeAbrioEnLaSesion: boolean; loCerroElDueno: boolean }): boolean {
  return s.mode === "implementacion" && !s.yaSeAbrioEnLaSesion && !s.loCerroElDueno;
}

/**
 * ¿Toca ofrecer ayuda de nuevo? Cuando la pantalla queda quieta en un paso PENDIENTE: el
 * dueño abrió la pantalla que le tocaba y no hizo nada, que es exactamente cuando se
 * abandona el montaje. No se insiste si ya está abierto, si no falta nada, o si ya se le
 * ofreció por este mismo paso.
 */
export const INACTIVIDAD_MS = 60_000;

export function debeOfrecerAyuda(s: {
  mode: string;
  abierto: boolean;
  msQuieto: number;
  pasoPendienteKey: string | null;
  yaOfrecidoParaPaso: string | null;
}): boolean {
  if (s.mode !== "implementacion" || s.abierto) return false;
  if (!s.pasoPendienteKey) return false;
  if (s.yaOfrecidoParaPaso === s.pasoPendienteKey) return false;
  return s.msQuieto >= INACTIVIDAD_MS;
}
