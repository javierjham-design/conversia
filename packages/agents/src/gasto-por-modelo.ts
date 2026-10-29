/**
 * QUÉ LE VA A COSTAR AL CLIENTE CAMBIARLE EL MODELO (extra del §6, 29-oct-2026).
 *
 * El super admin puede subirle el modelo a un agente y eso MULTIPLICA el consumo de créditos
 * del cliente: de `gpt-4o-mini` (peso 1) a `claude-sonnet-4-6` (peso 20) son veinte veces
 * más por la misma conversación. La pantalla ya le decía al cliente cuántas conversaciones le
 * quedan con el modelo nuevo, pero nadie decía lo otro: **cuánto va a tener que pagar al mes
 * para mantener el mismo servicio**, ni si eso pasa del tope que él mismo fijó.
 *
 * Y el tope importa más que el precio: pasado el tope la recarga automática deja de cobrar y
 * el bot se pausa. Un cambio de modelo bien intencionado puede cortarle el servicio a mitad
 * de mes a un cliente que paga, y el super admin no tenía forma de verlo venir.
 *
 * Es pura y se mide sobre el consumo REAL de los últimos días, normalizado: la muestra viene
 * cobrada al peso que el cliente tiene HOY, así que se divide por ese peso antes de
 * multiplicar por el nuevo. Multiplicar sin dividir contaría el modelo dos veces.
 */

export interface GastoMensualEstimado {
  /** Créditos que consumiría en un mes con el modelo NUEVO. */
  creditosAlMes: number;
  /** Lo que ya le da el plan sin pagar nada extra. */
  incluidosDelPlan: number;
  /** Recargas del pack que necesitaría para cubrir el resto. */
  recargas: number;
  /** Lo que pagaría al mes en recargas, en CLP (sin contar la mensualidad del plan). */
  recargasClp: number;
  /** Tope mensual de recarga automática que el cliente fijó. */
  topeMensualClp: number;
  /** true = con el modelo nuevo su tope NO alcanza y el bot se le va a pausar. */
  superaElTope: boolean;
  /** Cuántas veces se multiplica su consumo (peso nuevo / peso actual). */
  factor: number;
  /** false = no hay consumo medido todavía; el estimado es una proyección pobre. */
  conDatosReales: boolean;
}

/**
 * Proyección del gasto mensual con otro modelo.
 *
 * Sin consumo medido (`creditosDeLaMuestra` en 0) devuelve el estimado en cero y
 * `conDatosReales: false`: es mejor decir "todavía no hay datos" que proyectar un número
 * inventado sobre el que alguien va a decidir.
 */
export function gastoMensualConOtroModelo(input: {
  /** Créditos consumidos en la muestra, tal como quedaron cobrados (al peso actual). */
  creditosDeLaMuestra: number;
  /** Días que cubre la muestra. 0 = sin datos. */
  diasDeLaMuestra: number;
  /** Peso del modelo que tiene HOY (con el que se cobró la muestra). */
  pesoActual: number;
  /** Peso del modelo al que se quiere cambiar. */
  pesoNuevo: number;
  /** Créditos que el plan le incluye al mes. */
  incluidosDelPlan: number;
  /** Precio y créditos del pack con el que recargaría. */
  packPrecioClp: number;
  packCreditos: number;
  /** Tope mensual de recarga automática que el cliente fijó. */
  topeMensualClp: number;
}): GastoMensualEstimado {
  const pesoActual = Math.max(1, input.pesoActual);
  const pesoNuevo = Math.max(1, input.pesoNuevo);
  const factor = pesoNuevo / pesoActual;
  const base = {
    incluidosDelPlan: Math.max(0, Math.round(input.incluidosDelPlan)),
    topeMensualClp: Math.max(0, Math.round(input.topeMensualClp)),
    factor,
  };
  if (!(input.creditosDeLaMuestra > 0) || !(input.diasDeLaMuestra > 0)) {
    return { ...base, creditosAlMes: 0, recargas: 0, recargasClp: 0, superaElTope: false, conDatosReales: false };
  }
  // La muestra se normaliza al peso de HOY antes de aplicar el nuevo: viene cobrada a ese
  // peso, y multiplicar sin dividir contaría el modelo dos veces.
  const porDiaAlPesoNuevo = (input.creditosDeLaMuestra / pesoActual / input.diasDeLaMuestra) * pesoNuevo;
  const creditosAlMes = Math.ceil(porDiaAlPesoNuevo * 30);
  const faltan = Math.max(0, creditosAlMes - base.incluidosDelPlan);
  const recargas = input.packCreditos > 0 ? Math.ceil(faltan / input.packCreditos) : 0;
  const recargasClp = recargas * Math.max(0, Math.round(input.packPrecioClp));
  return {
    ...base,
    creditosAlMes,
    recargas,
    recargasClp,
    // El tope manda sobre el precio: pasado el tope la recarga automática DEJA de cobrar y el
    // bot se pausa. Un cambio de modelo bien intencionado le corta el servicio a mitad de mes.
    superaElTope: base.topeMensualClp > 0 && recargasClp > base.topeMensualClp,
    conDatosReales: true,
  };
}

/** Una frase para el super admin, que es quien aprieta el botón. */
export function explicarGastoMensual(g: GastoMensualEstimado, modeloNuevo: string): string {
  if (!g.conDatosReales) {
    return `Esta cuenta todavía no tiene consumo medido, así que no se puede estimar qué le costaría ${modeloNuevo} al mes.`;
  }
  const plata = `$${g.recargasClp.toLocaleString("es-CL")}`;
  const base =
    `Con ${modeloNuevo} esta cuenta gastaría ~${g.creditosAlMes.toLocaleString("es-CL")} créditos al mes ` +
    `(${g.factor.toFixed(1)}× lo de hoy): ${g.recargas} recarga(s), ${plata} además del plan.`;
  if (!g.superaElTope) return base;
  return (
    `${base} SU TOPE MENSUAL ES $${g.topeMensualClp.toLocaleString("es-CL")}: no alcanza, así que su recarga automática ` +
    "va a dejar de cobrar y el bot se le va a pausar a mitad de mes. Antes de aplicarlo, hablalo con el cliente."
  );
}
