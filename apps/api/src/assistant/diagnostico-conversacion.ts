/**
 * ¿POR QUÉ NO RESPONDIÓ EL BOT EN ESTA CONVERSACIÓN? — regla pura.
 *
 * Es la pregunta que más llega, y hasta ahora la respuesta de Convi era adivinar. El problema
 * de fondo es que hay **seis causas distintas** que para el dueño se ven idénticas —el
 * cliente escribió y nadie contestó— y cada una se arregla de una forma completamente
 * distinta: una se arregla pagando, otra asignando un asistente, otra mandando una plantilla,
 * y otra no se arregla porque **es lo correcto** (alguien del equipo tomó la conversación).
 *
 * Separar esto en una función pura es lo que permite probar las seis con fixtures, en vez de
 * confiar en que el modelo deduzca bien a partir de un JSON suelto.
 *
 * El ORDEN importa: se evalúa de la causa más de fondo a la más puntual. Si la cuenta está
 * vencida, decir «está fuera de la ventana de 24 h» es cierto y además inútil — lo que hay
 * que arreglar primero es la cuenta.
 */

export type CausaDelSilencio =
  | "cuenta_vencida"
  | "sin_creditos"
  | "bot_pausado"
  | "intervencion_humana"
  | "sin_asistente"
  | "fuera_de_ventana"
  | "error_del_proveedor"
  | "respondio";

export interface EntradaDelDiagnostico {
  /** ¿La cuenta está vigente? (`evaluarVigencia`, la regla única). */
  cuentaVigente: boolean;
  /** Saldo de créditos. `null` = la cuenta no se cobra por créditos. */
  creditos: number | null;
  /** `aiEnabled` de la conversación. */
  iaActiva: boolean;
  /** Alguien del equipo tomó la conversación. */
  intervencionHumana: boolean;
  /** El canal tiene asistente por defecto. */
  tieneAsistente: boolean;
  /** Último mensaje ENTRANTE del cliente, para la ventana de 24 h. */
  ultimoEntranteEn: Date | null;
  /** Último mensaje SALIENTE, para saber si en realidad sí respondió. */
  ultimoSalienteEn: Date | null;
  /** El error del último saliente fallido, si lo hay. */
  errorDelProveedor: string | null;
  ahora?: Date;
}

export interface Diagnostico {
  causa: CausaDelSilencio;
  /** Qué pasó, en una línea y sin jerga. */
  que: string;
  /** Qué hay que hacer. `null` cuando no hay nada que arreglar. */
  comoSeArregla: string | null;
  /** La herramienta de Convi que lo resuelve, si existe. */
  herramienta: string | null;
}

export const VENTANA_HORAS = 24;

export function porQueNoRespondio(e: EntradaDelDiagnostico): Diagnostico {
  const ahora = e.ahora ?? new Date();

  // 1. La cuenta. Es la de más abajo: con la cuenta vencida la IA está detenida para TODO,
  //    y cualquier otra explicación, aunque sea cierta, manda al dueño por el camino largo.
  if (!e.cuentaVigente) {
    return {
      causa: "cuenta_vencida",
      que: "La cuenta está vencida, así que el asistente está detenido en todas las conversaciones.",
      comoSeArregla: "Renovar el plan. Apenas se confirme el pago vuelve a responder solo.",
      herramienta: "generarEnlaceDePago",
    };
  }

  // 2. Los créditos. Mismo razonamiento: sin saldo no hay respuesta en ninguna parte.
  if (e.creditos !== null && e.creditos <= 0) {
    return {
      causa: "sin_creditos",
      que: "Se acabaron los créditos, así que el asistente dejó de responder.",
      comoSeArregla: "Recargar créditos. Si quieres que no vuelva a pasar, puedo dejarte la recarga automática.",
      herramienta: "generarEnlaceDePago",
    };
  }

  // 3. Alguien del equipo la tomó. Esto NO es un problema: es lo correcto, y decirle al dueño
  //    "arregla esto" cuando su propia gente está atendiendo sería desinformarlo.
  if (e.intervencionHumana) {
    return {
      causa: "intervencion_humana",
      que: "Alguien del equipo tomó esta conversación, así que el asistente se corrió a un lado a propósito.",
      comoSeArregla: null,
      herramienta: "retomarBotEnConversacion",
    };
  }

  if (!e.iaActiva) {
    return {
      causa: "bot_pausado",
      que: "El asistente está pausado en esta conversación.",
      comoSeArregla: "Reanudarlo para que vuelva a contestar acá.",
      herramienta: "retomarBotEnConversacion",
    };
  }

  if (!e.tieneAsistente) {
    return {
      causa: "sin_asistente",
      que: "El canal no tiene ningún asistente asignado, así que los mensajes llegan y nadie contesta.",
      comoSeArregla: "Asignar un asistente al canal.",
      herramienta: "asignarAsistenteACanal",
    };
  }

  // 4. El error del proveedor va ANTES de la ventana: si Meta rechazó el envío, ese es el
  //    hecho concreto, y la ventana es apenas una de las razones posibles del rechazo.
  if (e.errorDelProveedor) {
    return {
      causa: "error_del_proveedor",
      que: `El último intento de respuesta lo rechazó Meta: ${e.errorDelProveedor.slice(0, 160)}`,
      comoSeArregla: "Depende del error. Si es de la cuenta de WhatsApp, lo reviso contigo.",
      herramienta: "probarCanal",
    };
  }

  // 5. La ventana de 24 h. No es un error nuestro: es como funciona WhatsApp.
  const horas = e.ultimoEntranteEn ? (ahora.getTime() - e.ultimoEntranteEn.getTime()) / 3_600_000 : Infinity;
  if (horas > VENTANA_HORAS) {
    return {
      causa: "fuera_de_ventana",
      que: `El cliente escribió hace más de ${VENTANA_HORAS} horas. Pasado ese plazo, WhatsApp solo deja escribirle con una plantilla aprobada.`,
      comoSeArregla: "Mandarle una plantilla para reabrir la conversación.",
      herramienta: "listarPlantillasWhatsapp",
    };
  }

  // 6. Respondió de verdad: el saliente es POSTERIOR al último entrante.
  if (e.ultimoSalienteEn && e.ultimoEntranteEn && e.ultimoSalienteEn >= e.ultimoEntranteEn) {
    return {
      causa: "respondio",
      que: "El asistente sí respondió en esta conversación.",
      comoSeArregla: null,
      herramienta: null,
    };
  }

  // Nada de lo anterior: está todo en orden y la respuesta debería estar saliendo.
  return {
    causa: "respondio",
    que: "No veo nada que lo esté bloqueando: la cuenta está al día, hay asistente y la conversación está dentro de plazo.",
    comoSeArregla: "Si el cliente sigue sin recibir respuesta, lo escalo para revisarlo a fondo.",
    herramienta: null,
  };
}
