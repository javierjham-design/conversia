/**
 * EL PISO DE GANANCIA DE UN PACK, EN UN SOLO LUGAR (§3 del encargo del 29-oct).
 *
 * La regla del dueño es que todo lo que se vende deje al menos 300% de ganancia sobre costo.
 * Hasta ahora esa cuenta vivía SOLO en el test del catálogo: protegía los precios que están
 * en el repo, y no los que el super admin escribe a mano en la pantalla de paquetes. Un cero
 * de más en los créditos, o uno de menos en el precio, y se empieza a vender saldo bajo costo
 * sin que nada lo frene — y los packs que el dueño sacó del catálogo el 28-oct salieron
 * justamente por no cumplir esta regla.
 *
 * El costo de un pack son tres cosas, no una: los créditos que el cliente va a consumir, la
 * comisión de la pasarela sobre lo cobrado, y (solo en un plan) el costo fijo por cliente. Y
 * el precio es CON IVA incluido, así que lo que entra de verdad es el neto.
 *
 * Es puro y los supuestos se reciben: los mismos que usa el test, leídos del mismo
 * `seeds/creditos-catalogo.json`. Así "la misma cuenta que el test" es literal y no una
 * promesa en un comentario.
 */

export interface SupuestosDeCosto {
  /** Lo que nos cuesta un crédito de IA, en CLP. */
  costoPorCreditoClp: number;
  /** Comisión de la pasarela, en % de lo cobrado. */
  comisionFlowPct: number;
  /** Costo fijo por cliente al mes (solo aplica a un plan, no a un pack). */
  costoFijoPorClienteClp: number;
  ivaPct: number;
  /** Piso de ganancia sobre costo, en %. */
  gananciaMinimaPct: number;
}

/** Neto (sin IVA) de un precio con IVA incluido. */
export function netoSinIva(precioConIva: number, ivaPct: number): number {
  return precioConIva / (1 + ivaPct / 100);
}

/**
 * Ganancia sobre el costo, en %: cuántas veces recuperamos lo que gastamos.
 *
 * Devuelve `-Infinity` si el costo sale 0 o negativo (un pack de 0 créditos a precio 0): no
 * es "ganancia infinita", es una fila que no se puede evaluar, y dejarla pasar como válida
 * sería abrir la puerta justo por donde no se mira.
 */
export function gananciaSobreCostoPct(input: {
  precioClp: number;
  creditos: number;
  costoFijoClp?: number;
  s: SupuestosDeCosto;
}): number {
  const { s } = input;
  const ingresoNeto = netoSinIva(input.precioClp, s.ivaPct);
  const costo = input.creditos * s.costoPorCreditoClp + input.precioClp * (s.comisionFlowPct / 100) + (input.costoFijoClp ?? 0);
  if (!(costo > 0)) return Number.NEGATIVE_INFINITY;
  return ((ingresoNeto - costo) / costo) * 100;
}

export type ProblemaDelPack =
  /** Deja menos que el piso de ganancia: se vendería demasiado barato. */
  | "bajo_el_piso"
  /** Un pack más caro daría MENOS créditos por peso que uno más barato. */
  | "orden_roto"
  /** Precio o créditos en cero: la fila no se puede evaluar. */
  | "sin_datos"
  | null;

export interface PackDelCatalogo {
  code: string;
  credits: number;
  priceClp: number;
}

/**
 * ¿Se puede guardar este pack?
 *
 * Dos reglas, y la segunda es la que no se ve venir: si un pack MÁS CARO da menos créditos
 * por peso que uno más barato, al cliente le conviene comprar el chico varias veces y el
 * "pack grande" es una trampa. Se evalúa contra los OTROS packs de la misma bolsa, con el
 * pack que se está guardando ya sustituido (editar un precio tiene que poder romper el orden
 * igual que crear un pack nuevo).
 */
export function problemaDelPack(input: {
  pack: PackDelCatalogo;
  /** Los demás packs de la misma marca y unidad, tal como están hoy. */
  otros: PackDelCatalogo[];
  s: SupuestosDeCosto;
}): ProblemaDelPack {
  const { pack, s } = input;
  if (!(pack.priceClp > 0) || !(pack.credits > 0)) return "sin_datos";
  if (gananciaSobreCostoPct({ precioClp: pack.priceClp, creditos: pack.credits, s }) < s.gananciaMinimaPct) {
    return "bajo_el_piso";
  }
  // El catálogo resultante, ordenado por precio: los créditos por peso tienen que ir
  // creciendo (o al menos no bajar).
  const catalogo = [...input.otros.filter((p) => p.code !== pack.code && p.priceClp > 0 && p.credits > 0), pack].sort(
    (a, b) => a.priceClp - b.priceClp,
  );
  for (let i = 1; i < catalogo.length; i++) {
    const anterior = catalogo[i - 1].credits / catalogo[i - 1].priceClp;
    const actual = catalogo[i].credits / catalogo[i].priceClp;
    // Tolerancia de una milésima de crédito por peso: dos packs con el mismo precio por
    // crédito son válidos, y no se va a rechazar una fila por un redondeo.
    if (actual < anterior - 1e-9) return "orden_roto";
  }
  return null;
}

/** Mensaje para el super admin: dice qué está mal y con qué número comparar. */
export function explicarProblemaDelPack(
  problema: Exclude<ProblemaDelPack, null>,
  pack: PackDelCatalogo,
  s: SupuestosDeCosto,
): string {
  if (problema === "sin_datos") {
    return "El pack necesita un precio y una cantidad de créditos mayores que cero para poder evaluarse.";
  }
  if (problema === "bajo_el_piso") {
    const deja = gananciaSobreCostoPct({ precioClp: pack.priceClp, creditos: pack.credits, s });
    return (
      `Ese pack deja ${Math.round(deja)}% de ganancia sobre costo y el piso es ${s.gananciaMinimaPct}%. ` +
      `Con ${pack.credits.toLocaleString("es-CL")} créditos, el precio mínimo es ` +
      `$${Math.ceil(precioMinimo(pack.credits, s)).toLocaleString("es-CL")}.`
    );
  }
  return (
    "Un pack más caro no puede dar menos créditos por peso que uno más barato: así al cliente le conviene comprar " +
    "el chico varias veces y el pack grande es una trampa. Revisá el precio o los créditos."
  );
}

/**
 * Precio mínimo (con IVA) para que `creditos` cumplan el piso. Es la cifra que el super admin
 * necesita para corregir, en vez de ir tanteando hasta que la pantalla deje de rechazarlo.
 *
 * Se despeja de la fórmula de la ganancia:
 *   neto = P/(1+iva)              costo = C·k + P·f
 *   (neto − costo)/costo ≥ g   ⇒   P · (1/(1+iva) − f·(1+g)) ≥ C·k·(1+g)
 */
export function precioMinimo(creditos: number, s: SupuestosDeCosto): number {
  const g = 1 + s.gananciaMinimaPct / 100;
  const f = s.comisionFlowPct / 100;
  const coef = 1 / (1 + s.ivaPct / 100) - f * g;
  if (!(coef > 0)) return Number.POSITIVE_INFINITY; // la comisión se come el margen: no hay precio que sirva
  return (creditos * s.costoPorCreditoClp * g) / coef;
}
