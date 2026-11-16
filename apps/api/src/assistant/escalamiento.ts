/**
 * CUÁNDO SE ESCALA, Y QUÉ SE DICE AL HACERLO — regla pura.
 *
 * Lo que había antes era un comodín repetido en tres lugares del prompt: «si no puedes
 * resolver, escala». Con esa instrucción y sin herramientas para actuar, el modelo escalaba
 * TODO — incluida una cuenta vencida, que se resuelve con un botón de pago. Y lo peor es que
 * el mensaje era falso: `escalarAHumano` no le avisaba a nadie. «He informado tu caso al
 * equipo» era, literalmente, una frase.
 *
 * Ahora la lista es CERRADA. Cinco motivos, y nada más. Si algo no está acá, Convi lo
 * resuelve o lo intenta; no se rinde.
 */

export const MOTIVOS_DE_ESCALAMIENTO = [
  /** Trámite de Meta que solo puede hacer el dueño con su documentación. */
  "verificacion_meta",
  /** La cuenta de WhatsApp quedó restringida o hay que apelar. */
  "restriccion_whatsapp",
  /** Un cobro en disputa o una devolución: toca plata ajena. */
  "disputa_de_cobro",
  /** Algo nuestro quedó mal: pago registrado sin suscripción, 5xx repetido de una tool. */
  "inconsistencia_interna",
  /** Lo pidió el cliente con todas sus letras. */
  "pidio_una_persona",
] as const;

export type MotivoDeEscalamiento = (typeof MOTIVOS_DE_ESCALAMIENTO)[number];

export function esMotivoValido(m: string): m is MotivoDeEscalamiento {
  return (MOTIVOS_DE_ESCALAMIENTO as readonly string[]).includes(m);
}

/** Cómo se le explica cada motivo al dueño. Sin culpar al cliente y sin jerga. */
export const TEXTO_DEL_MOTIVO: Record<MotivoDeEscalamiento, string> = {
  verificacion_meta: "Meta pide verificar tu negocio y ese trámite lo tiene que hacer una persona del equipo contigo.",
  restriccion_whatsapp: "Tu cuenta de WhatsApp tiene una restricción de Meta y hay que apelarla.",
  disputa_de_cobro: "Es un tema de un cobro y lo revisa una persona del equipo.",
  inconsistencia_interna: "Encontré algo que está mal de nuestro lado, no tuyo.",
  pidio_una_persona: "Te comunico con una persona del equipo.",
};

export interface EntradaDeEscalamiento {
  motivo: string;
  /** Las tools que Convi ya ejecutó en este hilo. */
  consultado: string[];
}

export interface DecisionDeEscalamiento {
  escala: boolean;
  /** Por qué NO, cuando no escala. Es lo que Convi tiene que hacer en vez de escalar. */
  enVezDe: string | null;
  motivo: MotivoDeEscalamiento | null;
}

/**
 * ¿Corresponde escalar?
 *
 * Dos condiciones. La primera es la lista cerrada. La segunda es que **Convi haya mirado
 * algo antes**: escalar sin haber ejecutado ni una herramienta de diagnóstico es exactamente
 * el comportamiento viejo —rendirse— con un nombre nuevo. La única excepción es que el
 * cliente pida una persona: ahí no hay nada que diagnosticar, lo pidió y punto.
 */
export function decidirEscalamiento(e: EntradaDeEscalamiento): DecisionDeEscalamiento {
  const m = (e.motivo ?? "").trim();
  if (!esMotivoValido(m)) {
    return {
      escala: false,
      enVezDe:
        "Eso no se escala: resuélvelo con las herramientas que tienes. Si no diste con la causa, usa primero las de diagnóstico (estadoDeCuenta, porQueNoRespondioElBot, probarCanal).",
      motivo: null,
    };
  }
  if (m !== "pidio_una_persona" && e.consultado.length === 0) {
    return {
      escala: false,
      enVezDe:
        "Antes de escalar tienes que haber mirado algo: ejecuta al menos una herramienta de diagnóstico y cuenta qué encontraste.",
      motivo: null,
    };
  }
  return { escala: true, enVezDe: null, motivo: m };
}

/**
 * El mensaje que recibe el dueño al escalar.
 *
 * Tiene que decir tres cosas, y las tres importan: **qué intenté**, **qué encontré** y **qué
 * sigue pasando mientras tanto**. Un «lo derivé al equipo» a secas deja al dueño sin saber si
 * alguien va a mirarlo, cuándo, ni qué hacer entretanto — que es justo la sensación que
 * queremos eliminar.
 */
export function mensajeDeEscalamiento(input: {
  motivo: MotivoDeEscalamiento;
  codigo: string;
  consultado: string[];
  /** Plazo de respuesta, de `platform_settings.support.sla`. Nunca escrito a mano. */
  sla: string | null;
}): string {
  const partes: string[] = [TEXTO_DEL_MOTIVO[input.motivo]];
  if (input.consultado.length) {
    partes.push(`Ya revisé ${input.consultado.slice(0, 3).join(", ")}.`);
  }
  partes.push(`Lo dejé con el equipo con el código ${input.codigo}.`);
  if (input.sla) partes.push(input.sla);
  partes.push("Te respondo por acá mismo apenas haya novedad.");
  return partes.join(" ");
}

/** Plazo por defecto si `platform_settings.support.sla` no está configurado. */
export const SLA_POR_DEFECTO = "Te respondemos dentro del horario hábil, normalmente en menos de 4 horas.";
