/**
 * CRE 3 — EL ESTIMADOR: traducir créditos a algo que el dueño entienda.
 *
 * "Te quedan 1.240 créditos" no le dice nada a nadie. "1.240 créditos ≈ 140 conversaciones
 * ≈ 18 días a tu ritmo" sí. Esta es la pieza que hace esa traducción, y es puramente
 * aritmética: las lecturas de base de datos viven en quien la llama (API y worker), para que
 * las dos superficies usen EXACTAMENTE el mismo cálculo y no se contradigan en pantalla.
 *
 * Dos reglas que importan:
 *
 *  - Con pocas conversaciones propias, el promedio de la org es ruido: una sola conversación
 *    larga con un modelo caro dispara la media y el dueño ve "te quedan 3 conversaciones"
 *    cuando le quedan cien. Por debajo del mínimo se usa el promedio del rubro.
 *  - La estimación se queda CORTA a propósito (redondea los días hacia abajo y las
 *    conversaciones hacia abajo): prometer más días de los que hay es peor que prometer
 *    menos. Que el bot dure más de lo dicho es una buena sorpresa; lo contrario es un bot
 *    que se corta sin aviso.
 */

/** Mínimo de conversaciones propias para fiarse del promedio de la org. */
export const MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO = 20;

/** Promedio de respaldo cuando no hay datos ni de la org ni del rubro. */
export const CREDITOS_POR_CONVERSACION_POR_DEFECTO = 9;

export interface MuestraDeConsumo {
  /** Conversaciones del período con al menos una respuesta del bot. */
  conversaciones: number;
  /** Créditos debitados en el período. */
  creditos: number;
  /** Días que abarca la muestra (para el ritmo diario). */
  dias: number;
}

export interface EntradaEstimacion {
  /** Créditos disponibles ahora. */
  restantes: number;
  /** Consumo propio de la org en el período (normalmente 30 días). */
  propio: MuestraDeConsumo;
  /**
   * Promedio del rubro, para cuando la org todavía no tiene historia suficiente.
   * `null` = no hay dato del rubro → se usa el de por defecto.
   */
  promedioDelRubro?: number | null;
}

export interface Estimacion {
  restantes: number;
  /** Créditos que cuesta una conversación según la base elegida. */
  creditosPorConversacion: number;
  /** Conversaciones que alcanzan con lo que queda. */
  conversaciones: number;
  /** Días que alcanzan al ritmo observado. `null` = sin ritmo medible todavía. */
  dias: number | null;
  /** De dónde salió el promedio: su propio consumo, el del rubro, o el de por defecto. */
  base: "org" | "rubro" | "defecto";
  /** Conversaciones propias que respaldan la estimación (para explicarla). */
  muestra: number;
}

/** Promedio de créditos por conversación de una muestra. 0 conversaciones → null. */
export function promedioPorConversacion(m: MuestraDeConsumo): number | null {
  if (m.conversaciones <= 0 || m.creditos <= 0) return null;
  return m.creditos / m.conversaciones;
}

/**
 * La estimación. Elige la base en este orden: promedio propio (si hay muestra suficiente) →
 * promedio del rubro → valor por defecto.
 */
export function estimarAlcance(input: EntradaEstimacion): Estimacion {
  const restantes = Math.max(0, Math.floor(input.restantes));
  const propio = promedioPorConversacion(input.propio);
  const hayMuestra = input.propio.conversaciones >= MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO && propio != null;

  let creditosPorConversacion: number;
  let base: Estimacion["base"];
  if (hayMuestra) {
    creditosPorConversacion = propio!;
    base = "org";
  } else if (input.promedioDelRubro && input.promedioDelRubro > 0) {
    creditosPorConversacion = input.promedioDelRubro;
    base = "rubro";
  } else {
    creditosPorConversacion = CREDITOS_POR_CONVERSACION_POR_DEFECTO;
    base = "defecto";
  }

  // Hacia abajo: mejor que el saldo dure más de lo prometido, no menos.
  const conversaciones = Math.floor(restantes / creditosPorConversacion);

  // El ritmo diario SIEMPRE sale del consumo real de la org: el promedio del rubro dice
  // cuánto cuesta una conversación, no cuántas tiene este negocio por día. Sin consumo
  // propio no hay ritmo que medir y se devuelve null en vez de inventar una cifra.
  let dias: number | null = null;
  if (input.propio.dias > 0 && input.propio.creditos > 0) {
    const porDia = input.propio.creditos / input.propio.dias;
    if (porDia > 0) dias = Math.floor(restantes / porDia);
  }

  return {
    restantes,
    creditosPorConversacion: Math.round(creditosPorConversacion * 10) / 10,
    conversaciones,
    dias,
    base,
    muestra: input.propio.conversaciones,
  };
}

/**
 * La frase del medidor, la MISMA en Inicio, Cobros, el copiloto y los avisos: si cada
 * superficie la armara por su cuenta, terminarían diciendo números distintos del mismo
 * saldo y el dueño dejaría de creerle a todas.
 */
export function frasePorSaldo(e: Estimacion): string {
  const n = (x: number) => x.toLocaleString("es-CL");
  if (e.restantes <= 0) return "Sin créditos disponibles";
  const partes = [`${n(e.restantes)} créditos`];
  if (e.conversaciones > 0) partes.push(`≈ ${n(e.conversaciones)} conversaciones`);
  if (e.dias != null && e.dias > 0) partes.push(`≈ ${n(e.dias)} días a tu ritmo`);
  return partes.join(" · ");
}

/** De dónde salió el número, en una línea, para que la estimación no parezca magia. */
export function explicarBase(e: Estimacion): string {
  switch (e.base) {
    case "org":
      return `Calculado con tus últimas ${e.muestra.toLocaleString("es-CL")} conversaciones: ${e.creditosPorConversacion} créditos cada una en promedio.`;
    case "rubro":
      return `Estimado con el promedio de negocios como el tuyo (${e.creditosPorConversacion} créditos por conversación). Cuando tengas ${MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO} conversaciones lo calculamos con las tuyas.`;
    default:
      return `Estimado con un promedio general (${e.creditosPorConversacion} créditos por conversación) porque todavía no hay historial.`;
  }
}
