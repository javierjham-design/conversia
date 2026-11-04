import { CREDITOS_POR_CONVERSACION_RESPALDO, PACKS_RESPALDO, PRUEBA_RESPALDO_CREDITOS } from "@/lib/precios-respaldo";

/**
 * NÚCLEO de precios: tipos + la derivación PURA de lo que una página pública puede decir.
 *
 * Vive aparte de `usar-precios.ts` (que lleva `"use client"`) por dos razones:
 *  - el **servidor** lo necesita para dejar el precio ya en el HTML, y un componente de
 *    servidor que importa de un módulo `"use client"` recibe una referencia de cliente, no la
 *    función;
 *  - sin React en el medio, la regla que de verdad importa se puede probar a secas.
 *
 * LA REGLA: **un precio que no está confirmado por el servidor no se muestra.** `basePrice` y
 * `baseIncluded` son `null` mientras no haya catálogo, y el tipo obliga a cada página a
 * resolver ese caso. No es teoría: el 3-nov `conversia.cl` sirvió "Desde $24.990 al mes" y
 * "300 conversaciones incluidos" durante horas, porque el respaldo del catálogo de CRÉDITOS
 * —que está apagado— contestaba por el de conversaciones, que cobra $18.900 por 30. Un
 * respaldo solo puede hablar del catálogo que se confirmó activo.
 */

export interface Plan {
  code: string;
  priceClp: number;
  features?: Record<string, unknown> | null;
}

export interface Pack {
  code: string;
  credits: number;
  priceClp: number;
  bonoPct?: number;
  creditosPorConversacion?: number;
}

/** Catálogo ya leído (por el servidor) para entrar como estado inicial del hook. */
export interface CatalogoInicial {
  base: Plan | null;
  packs: Pack[];
}

export interface Precios {
  /** ¿El catálogo ACTIVO es el de Créditos IA? Decide la unidad y el discurso de cobro. */
  esCreditos: boolean;
  /** "créditos" o "conversaciones". Nunca se escribe a mano en una página. */
  unidad: string;
  /** Precio del plan Base ya formateado, o **null si el catálogo no está confirmado**. */
  basePrice: string | null;
  /** Cuánto incluye el plan Base al mes, o **null si no está confirmado**. */
  baseIncluded: number | null;
  /** Lo que regala la prueba, en `unidad`. */
  pruebaGratis: number;
  /** Créditos que consume una conversación promedio (MEDIDO, lo manda el servidor). */
  porConversacion: number;
  /** Packs de recarga, con su bono ya calculado por el servidor. Vacío = no hay qué mostrar. */
  packs: Pack[];
  /** Créditos → conversaciones aproximadas. */
  conv: (creditos: number) => number;
  /** Sufijo " (≈ N conversaciones)", vacío si la unidad ya es la conversación. */
  aprox: (creditos: number) => string;
  /** El plan Base llegó del servidor. `false` = no hay precio que mostrar. */
  desdeElServidor: boolean;
}

export const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

const BASE_CREDITOS = "conversia_creditos_base";
const BASE_V2 = "conversia_v2_base";

/**
 * Elige el plan Base del catálogo que está ACTIVO: si el de Créditos IA está encendido manda
 * ese; si no, el viejo. Un código desconocido NO sirve: antes que mostrar el precio de un plan
 * que no es el Base, no se muestra ninguno.
 */
export function elegirPlanBase(planes: Plan[] | null | undefined): Plan | null {
  if (!Array.isArray(planes)) return null;
  return planes.find((p) => p?.code === BASE_CREDITOS) ?? planes.find((p) => p?.code === BASE_V2) ?? null;
}

/** Deriva todo lo que una página pública dice de precios. Pura: mismo dato, misma salida. */
export function derivarPrecios(base: Plan | null, packs: Pack[]): Precios {
  const esCreditos = base?.code === BASE_CREDITOS;
  const unidad = esCreditos ? "créditos" : "conversaciones";

  const incluido = base ? Number(base.features?.aiCreditsIncluded ?? base.features?.conversationsIncluded) : Number.NaN;
  const basePrice = base ? clp(base.priceClp) : null;
  const baseIncluded = Number.isFinite(incluido) && incluido > 0 ? Math.floor(incluido) : null;

  // El regalo de la prueba sale del PLAN: `features.signupGiftCredits` es el mismo campo que
  // lee `auth.service.ts` para acreditarlo de verdad, así que la web no puede prometer un
  // número distinto del que la cuenta recibe. Sin catálogo rige el modelo viejo (30), que es
  // el que está en producción mientras los Créditos IA no se enciendan.
  const regaloDelPlan = Number(base?.features?.signupGiftCredits);
  const pruebaGratis = Number.isFinite(regaloDelPlan) && regaloDelPlan > 0
    ? Math.floor(regaloDelPlan)
    : esCreditos
      ? PRUEBA_RESPALDO_CREDITOS
      : 30;

  // El respaldo de packs es el del catálogo de CRÉDITOS, así que solo se usa cuando se
  // confirmó que ese catálogo es el activo. En el modelo de conversaciones no tenemos esos
  // números: la tarjeta se queda sin lista antes que inventar una.
  const aLaVista = packs.length ? packs : esCreditos ? [...PACKS_RESPALDO] : [];
  const porConversacion = packs.find((p) => p.creditosPorConversacion)?.creditosPorConversacion ?? CREDITOS_POR_CONVERSACION_RESPALDO;

  return {
    esCreditos,
    unidad,
    basePrice,
    baseIncluded,
    pruebaGratis,
    porConversacion,
    packs: aLaVista,
    conv: (creditos: number) => Math.floor(creditos / porConversacion),
    aprox: (creditos: number) => (esCreditos ? ` (≈ ${Math.floor(creditos / porConversacion).toLocaleString("es-CL")} conversaciones)` : ""),
    desdeElServidor: base !== null,
  };
}
