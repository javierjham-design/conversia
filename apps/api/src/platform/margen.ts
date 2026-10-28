/**
 * CRE 4 — MARGEN POR CLIENTE y CALIBRACIÓN, la parte decidible.
 *
 * Todo lo que acá se decide (qué margen tiene una cuenta, si hay que alertar, si los pesos
 * o el bloque de tokens quedaron mal calibrados) es aritmética con entradas explícitas, así
 * que se puede probar sin base de datos. Las lecturas viven en el controlador.
 *
 * Por qué importa que esto exista: los precios de la Etapa 2 se fijaron con una meta de
 * ≥300% de margen sobre el costo, calculada con el consumo HISTÓRICO. Si el consumo real
 * cambia —clientes que conversan más largo, un modelo más caro de lo previsto—, el margen
 * se cae sin que nadie se entere hasta que llega la factura del proveedor. Esto lo hace
 * visible por cuenta y por mes.
 */

/** Umbral de alerta del dueño: por debajo de esto una cuenta deja de ser negocio. */
export const MARGEN_MINIMO_PCT = 40;

/**
 * Costo de infraestructura que se le imputa a cada cuenta por mes (USD). Es una estimación
 * del dueño, no una medición: Railway/Redis/Postgres se cobran por el total, no por tenant.
 * Vive acá para que el día que se mida de verdad haya UN solo lugar que cambiar.
 */
export const INFRA_USD_POR_CUENTA_MES = 1.2;

export interface EntradaMargen {
  organizationId: string;
  nombre: string;
  /** Ingresos del mes en CLP (planes + recargas efectivamente cobrados). */
  ingresosClp: number;
  /** Costo real de IA del mes en USD (`ai_requests.costUsd`). */
  costoIaUsd: number;
  /** Costo de WhatsApp que paga Conversia en USD (0 si lo paga el cliente a Meta). */
  costoWhatsappUsd: number;
  /** Pesos por dólar con que se convierte el costo. */
  clpPorUsd: number;
}

export interface Margen {
  organizationId: string;
  nombre: string;
  ingresosClp: number;
  costoClp: number;
  margenClp: number;
  /** Margen sobre los INGRESOS (0-100). `null` si no hubo ingresos: sin ventas no hay margen. */
  margenPct: number | null;
  /** true si el margen quedó por debajo del mínimo (con ingresos > 0). */
  alerta: boolean;
  detalle: { iaClp: number; whatsappClp: number; infraClp: number };
}

/**
 * Margen de una cuenta en el mes. El porcentaje es sobre los INGRESOS (no sobre el costo,
 * como la meta de precios del §5): son dos números distintos y confundirlos haría ver 300%
 * donde hay 75%. Acá interesa "de cada peso que entra, cuánto queda", que es lo que decide
 * si la cuenta se sostiene.
 */
export function calcularMargen(e: EntradaMargen): Margen {
  const clp = (usd: number) => Math.round(usd * e.clpPorUsd);
  const iaClp = clp(Math.max(0, e.costoIaUsd));
  const whatsappClp = clp(Math.max(0, e.costoWhatsappUsd));
  const infraClp = clp(INFRA_USD_POR_CUENTA_MES);
  const costoClp = iaClp + whatsappClp + infraClp;
  const ingresosClp = Math.max(0, Math.round(e.ingresosClp));
  const margenClp = ingresosClp - costoClp;
  const margenPct = ingresosClp > 0 ? Math.round((margenClp / ingresosClp) * 100) : null;
  return {
    organizationId: e.organizationId,
    nombre: e.nombre,
    ingresosClp,
    costoClp,
    margenClp,
    margenPct,
    // Una cuenta en prueba (sin ingresos) NO es una alerta de margen: es una cuenta en
    // prueba. Alertar por ellas llenaría la consola de ruido y taparía las de verdad.
    alerta: ingresosClp > 0 && margenPct != null && margenPct < MARGEN_MINIMO_PCT,
    detalle: { iaClp, whatsappClp, infraClp },
  };
}

// ---------------------------------------------------------------------------
// Calibración
// ---------------------------------------------------------------------------

export interface EntradaCalibracion {
  /** Créditos debitados en el período. */
  creditos: number;
  /** Conversaciones distintas que los generaron. */
  conversaciones: number;
  /** Turnos del bot (respuestas) del período. */
  turnos: number;
  /** Tokens totales de esos turnos. */
  tokens: number;
  /** Bloque de tokens vigente (`tokensPerCredit` de la política). */
  tokensPorCredito: number;
  /** Costo real de IA del período en USD. */
  costoIaUsd: number;
  /** Pesos por dólar. */
  clpPorUsd: number;
  /** Precio al que se vende un crédito en CLP (el del pack básico). */
  precioCreditoClp: number;
}

export interface Calibracion {
  creditosPorConversacion: number;
  tokensPorTurno: number;
  /** Costo real de un crédito en CLP (lo que le cuesta a Conversia producirlo). */
  costoPorCreditoClp: number;
  /** Margen sobre el COSTO de un crédito, en % (la meta del dueño es ≥300%). */
  margenSobreCostoPct: number | null;
  /** Recomendación concreta, o null si no hay que tocar nada. */
  recomendacion: string | null;
  /** `tokensPerCredit` sugerido, si conviene cambiarlo. */
  tokensPorCreditoSugerido: number | null;
}

/**
 * Qué recomendar al cerrar el mes. Mira dos cosas distintas y las dice por separado:
 *
 *  - **El margen por crédito**: si el costo real de producir un crédito subió, el problema
 *    es el PRECIO o los PESOS, no el bloque de tokens.
 *  - **El bloque de tokens**: si la respuesta promedio usa muy pocos tokens respecto del
 *    bloque, casi todos los turnos cobran el mínimo de 1 bloque y el ajuste por largo deja
 *    de funcionar —se vuelve un cobro plano por respuesta—. Si los usa de más, cada
 *    respuesta cobra varios bloques y el cliente ve su saldo caer sin entender por qué.
 *
 * No recomienda nada sin muestra suficiente: una recomendación de calibración hecha con 30
 * turnos es peor que ninguna, porque invita a mover un precio por ruido.
 */
export const MIN_TURNOS_PARA_CALIBRAR = 200;

export function recomendarCalibracion(e: EntradaCalibracion): Calibracion {
  const creditosPorConversacion = e.conversaciones > 0 ? Math.round((e.creditos / e.conversaciones) * 10) / 10 : 0;
  const tokensPorTurno = e.turnos > 0 ? Math.round(e.tokens / e.turnos) : 0;
  const costoPorCreditoClp =
    e.creditos > 0 ? Math.round(((e.costoIaUsd * e.clpPorUsd) / e.creditos) * 100) / 100 : 0;
  const margenSobreCostoPct =
    costoPorCreditoClp > 0 ? Math.round(((e.precioCreditoClp - costoPorCreditoClp) / costoPorCreditoClp) * 100) : null;

  if (e.turnos < MIN_TURNOS_PARA_CALIBRAR) {
    return {
      creditosPorConversacion,
      tokensPorTurno,
      costoPorCreditoClp,
      margenSobreCostoPct,
      recomendacion: `Muestra insuficiente (${e.turnos} respuestas, se necesitan ${MIN_TURNOS_PARA_CALIBRAR}): todavía no conviene mover precios ni pesos.`,
      tokensPorCreditoSugerido: null,
    };
  }

  // 1) El margen manda: si el crédito se vende por debajo de la meta, eso va primero.
  if (margenSobreCostoPct != null && margenSobreCostoPct < 300) {
    return {
      creditosPorConversacion,
      tokensPorTurno,
      costoPorCreditoClp,
      margenSobreCostoPct,
      recomendacion: `El margen por crédito bajó a ${margenSobreCostoPct}% (meta ≥300%): producir un crédito cuesta $${costoPorCreditoClp} y se vende a $${e.precioCreditoClp}. Revisa los PESOS de los modelos caros o el precio de los packs, no el bloque de tokens.`,
      tokensPorCreditoSugerido: null,
    };
  }

  // 2) El bloque de tokens: ¿el ajuste por largo está haciendo algo?
  const ratio = e.tokensPorCredito > 0 ? tokensPorTurno / e.tokensPorCredito : 0;
  if (ratio > 0 && ratio < 0.25) {
    const sugerido = redondearBloque(tokensPorTurno * 2);
    return {
      creditosPorConversacion,
      tokensPorTurno,
      costoPorCreditoClp,
      margenSobreCostoPct,
      recomendacion: `La respuesta promedio usa ${tokensPorTurno} tokens y el bloque son ${e.tokensPorCredito}: casi todos los turnos cobran el mínimo de 1 bloque, así que el ajuste por largo no está haciendo nada (es un cobro plano por respuesta). Bajar el bloque a ~${sugerido} lo volvería a diferenciar.`,
      tokensPorCreditoSugerido: sugerido,
    };
  }
  if (ratio > 2) {
    const sugerido = redondearBloque(tokensPorTurno);
    return {
      creditosPorConversacion,
      tokensPorTurno,
      costoPorCreditoClp,
      margenSobreCostoPct,
      recomendacion: `La respuesta promedio usa ${tokensPorTurno} tokens contra un bloque de ${e.tokensPorCredito}: cada respuesta cobra ${Math.ceil(ratio)} bloques y el cliente ve su saldo caer más rápido de lo que espera. Subir el bloque a ~${sugerido} lo haría previsible.`,
      tokensPorCreditoSugerido: sugerido,
    };
  }

  return {
    creditosPorConversacion,
    tokensPorTurno,
    costoPorCreditoClp,
    margenSobreCostoPct,
    recomendacion: null,
    tokensPorCreditoSugerido: null,
  };
}

/** Redondea a un número "contable" (múltiplo de 1.000) para no sugerir 18.437. */
function redondearBloque(n: number): number {
  return Math.max(1_000, Math.round(n / 1_000) * 1_000);
}

// ---------------------------------------------------------------------------
// Utilidades de período
// ---------------------------------------------------------------------------

/**
 * Rango de un mes `YYYY-MM` (UTC). Sin parámetro: el mes en curso. Un valor que no se
 * entiende cae también al mes en curso en vez de reventar: el super admin pide un reporte,
 * no debería ver un 400 por un parámetro mal escrito en la URL.
 */
export function mesRango(month?: string): { desde: Date; hasta: Date; mes: string } {
  const ahora = new Date();
  let y = ahora.getUTCFullYear();
  let m = ahora.getUTCMonth();
  const match = /^(\d{4})-(\d{2})$/.exec((month ?? "").trim());
  if (match) {
    const yy = Number(match[1]);
    const mm = Number(match[2]);
    if (yy >= 2020 && yy <= 2100 && mm >= 1 && mm <= 12) {
      y = yy;
      m = mm - 1;
    }
  }
  const desde = new Date(Date.UTC(y, m, 1));
  const hasta = new Date(Date.UTC(y, m + 1, 1));
  return { desde, hasta, mes: `${y}-${String(m + 1).padStart(2, "0")}` };
}
