/**
 * EL BONO DE LOS PACKS DE CRÉDITOS (§1 del encargo del 29-oct-2026).
 *
 * Un pack grande da créditos EXTRA respecto de comprar lo mismo en recargas básicas: "+5%",
 * "+10%", "+15%". Es lo que el cliente ve y lo que justifica el pack.
 *
 * NO SE GUARDA EN LA BASE, se calcula: el bono es una relación entre el precio y los
 * créditos, y guardarlo aparte significa tener el mismo hecho escrito en dos lugares. En la
 * primera edición del super admin —cambiar el precio y olvidar el bono— la página pasaría a
 * prometer un extra que el pack no da, y eso es publicidad engañosa sobre un precio. Así el
 * número que se muestra no puede contradecir al que se cobra.
 *
 * El `bonoPct` del catálogo (`seeds/creditos-catalogo.json`) es la INTENCIÓN del dueño; un
 * test exige que el precio y los créditos sembrados la cumplan.
 */

export interface PackParaBono {
  credits: number;
  priceClp: number;
  /** true = la recarga básica, la que define el precio por crédito de referencia. */
  esRecargaBasica?: boolean;
}

/**
 * Bono de cada pack, en puntos porcentuales, contra el precio por crédito de la recarga
 * BÁSICA. Devuelve un mapa por índice del arreglo recibido.
 *
 * Sin recarga básica identificable se usa el pack MÁS BARATO como referencia: es el que un
 * cliente compraría por defecto, así que es contra ese que un pack grande tiene que ofrecer
 * algo. Y si hay un solo pack, su bono es 0 — no hay nada con qué compararlo.
 */
export function bonoDePacks<T extends PackParaBono>(packs: T[]): number[] {
  const validos = packs.filter((p) => p.credits > 0 && p.priceClp > 0);
  if (validos.length === 0) return packs.map(() => 0);
  const base = validos.find((p) => p.esRecargaBasica) ?? [...validos].sort((a, b) => a.priceClp - b.priceClp)[0];
  const porCreditoBase = base.priceClp / base.credits;
  return packs.map((p) => {
    if (p.credits <= 0 || p.priceClp <= 0 || porCreditoBase <= 0) return 0;
    const sinBono = p.priceClp / porCreditoBase;
    const bono = (p.credits / sinBono - 1) * 100;
    // Se redondea al entero y nunca se muestra un bono NEGATIVO: si un pack saliera más caro
    // por crédito que la recarga básica, lo que corresponde es no prometer nada (y lo caza
    // el test de orden del catálogo), no anunciarle al cliente un "-3%".
    return Math.max(0, Math.round(bono));
  });
}

/** Texto del bono para la UI. Vacío cuando no hay bono que anunciar. */
export function textoDelBono(bonoPct: number): string {
  return bonoPct > 0 ? `+${bonoPct}% de créditos extra` : "";
}
