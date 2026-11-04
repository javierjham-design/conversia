"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  BASE_RESPALDO,
  CREDITOS_POR_CONVERSACION_RESPALDO,
  PACKS_RESPALDO,
  PRUEBA_RESPALDO_CREDITOS,
} from "@/lib/precios-respaldo";

/**
 * M0 — UNA SOLA FUENTE para todo lo que una página pública dice sobre precios y sobre la
 * prueba gratis.
 *
 * Por qué existe: la landing ya resolvía bien esto (sigue al catálogo ACTIVO, con respaldos
 * que un test compara contra el catálogo), pero `/crear` tenía **"30 conversaciones de
 * regalo" escrito a mano**. Dos lugares decidiendo lo mismo = el día que el dueño encienda
 * los Créditos IA, uno dice 200 créditos y el otro sigue diciendo 30 conversaciones, en el
 * mismo embudo y a dos clics de distancia. M2 agrega cuatro páginas de rubro y `/precios`,
 * que necesitan exactamente estos números: si cada una los deriva por su cuenta, el problema
 * se multiplica por seis.
 *
 * LO IMPORTANTE: **nada de esto es un número escrito a mano.** Todo sale del catálogo que
 * está activo en el servidor, así que mientras los Créditos IA estén apagados la web dice la
 * verdad del modelo viejo (`$18.900` · 30 conversaciones · "pagas por conversación") y pasa a
 * decir la del nuevo ($24.990 · 200 créditos · "pagas por respuesta") **el día que el dueño
 * corra el go-live, sin desplegar nada**. Los `*_RESPALDO` solo aparecen si la llamada no
 * llega, y hay un test que los ata al catálogo.
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

export interface Precios {
  /** ¿El catálogo ACTIVO es el de Créditos IA? Decide la unidad y el discurso de cobro. */
  esCreditos: boolean;
  /** "créditos" o "conversaciones". Nunca se escribe a mano en una página. */
  unidad: string;
  /** Precio del plan Base ya formateado en CLP. */
  basePrice: string;
  /** Cuánto incluye el plan Base al mes, en `unidad`. */
  baseIncluded: number;
  /** Lo que regala la prueba, en `unidad`. */
  pruebaGratis: number;
  /** Créditos que consume una conversación promedio (MEDIDO, lo manda el servidor). */
  porConversacion: number;
  /** Packs de recarga, con su bono ya calculado por el servidor. */
  packs: Pack[];
  /** Créditos → conversaciones aproximadas. */
  conv: (creditos: number) => number;
  /** Sufijo " (≈ N conversaciones)", vacío si la unidad ya es la conversación. */
  aprox: (creditos: number) => string;
  /** El plan Base llegó del servidor (false = se está mostrando el respaldo). */
  desdeElServidor: boolean;
}

export const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

export function usarPrecios(): Precios {
  const [base, setBase] = useState<Plan | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);

  useEffect(() => {
    api<Plan[]>("/public/plans?brand=conversia")
      .then((p) => setBase(p.find((x) => x.code === "conversia_creditos_base") ?? p.find((x) => x.code === "conversia_v2_base") ?? null))
      .catch(() => {});
    api<Pack[]>("/public/conversation-packs?brand=conversia").then(setPacks).catch(() => {});
  }, []);

  const esCreditos = base?.code === "conversia_creditos_base";
  const unidad = esCreditos ? "créditos" : "conversaciones";
  const basePrice = base ? clp(base.priceClp) : clp(BASE_RESPALDO.priceClp);
  const baseIncluded = base
    ? Number(base.features?.aiCreditsIncluded ?? base.features?.conversationsIncluded) || BASE_RESPALDO.creditos
    : BASE_RESPALDO.creditos;

  // El regalo de la prueba sale del PLAN, no de una constante: `features.signupGiftCredits`
  // es el mismo campo que lee `auth.service.ts` para acreditarlo de verdad, así que la web no
  // puede prometer un número distinto del que la cuenta recibe. Si el plan no lo trae, cae al
  // respaldo que el test ata al catálogo (200) o a 30 en el modelo viejo.
  const regaloDelPlan = Number(base?.features?.signupGiftCredits);
  const pruebaGratis = Number.isFinite(regaloDelPlan) && regaloDelPlan > 0
    ? Math.floor(regaloDelPlan)
    : esCreditos
      ? PRUEBA_RESPALDO_CREDITOS
      : 30;

  const porConversacion = packs.find((p) => p.creditosPorConversacion)?.creditosPorConversacion ?? CREDITOS_POR_CONVERSACION_RESPALDO;
  const conv = (creditos: number) => Math.floor(creditos / porConversacion);
  const aprox = (creditos: number) => (esCreditos ? ` (≈ ${conv(creditos).toLocaleString("es-CL")} conversaciones)` : "");

  return {
    esCreditos,
    unidad,
    basePrice,
    baseIncluded,
    pruebaGratis,
    porConversacion,
    packs: packs.length ? packs : [...PACKS_RESPALDO],
    conv,
    aprox,
    desdeElServidor: base !== null,
  };
}
