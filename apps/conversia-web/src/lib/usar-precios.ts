"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { derivarPrecios, elegirPlanBase, type CatalogoInicial, type Pack, type Plan, type Precios } from "@/lib/precios-nucleo";

/**
 * M0 — UNA SOLA FUENTE para todo lo que una página pública dice sobre precios y sobre la
 * prueba gratis.
 *
 * Por qué existe: la landing ya resolvía bien esto, pero `/crear` tenía **"30 conversaciones
 * de regalo" escrito a mano**. Dos lugares decidiendo lo mismo = el día que el dueño encienda
 * los Créditos IA, uno dice 200 créditos y el otro sigue diciendo 30 conversaciones, en el
 * mismo embudo y a dos clics de distancia. M2 agrega cuatro páginas de rubro y `/precios`,
 * que necesitan exactamente estos números.
 *
 * LO IMPORTANTE: **nada de esto es un número escrito a mano.** Todo sale del catálogo que está
 * activo en el servidor, así que mientras los Créditos IA estén apagados la web dice la verdad
 * del modelo viejo y pasa a decir la del nuevo **el día que el dueño corra el go-live, sin
 * desplegar nada**.
 *
 * `inicial` es el catálogo que ya leyó el SERVIDOR (ver `precios-servidor.ts`): sin eso, el
 * HTML prerenderizado sale sin precio y el número aparece recién al hidratar — que es como la
 * portada terminó sirviendo un precio equivocado a Google y al revisor de anuncios de Meta.
 * La derivación y la regla de "sin confirmar no se muestra" viven en `precios-nucleo.ts`.
 */

export { clp, derivarPrecios, elegirPlanBase } from "@/lib/precios-nucleo";
export type { CatalogoInicial, Pack, Plan, Precios } from "@/lib/precios-nucleo";

export function usarPrecios(inicial?: CatalogoInicial | null): Precios {
  const [base, setBase] = useState<Plan | null>(inicial?.base ?? null);
  const [packs, setPacks] = useState<Pack[]>(inicial?.packs ?? []);

  // Se vuelve a pedir en el cliente para que un cambio de catálogo se vea sin esperar a que
  // caduque el prerenderizado. Solo se PISA lo que ya había si la respuesta trae algo útil:
  // una llamada que falla no puede degradar un precio que el servidor ya confirmó.
  useEffect(() => {
    api<Plan[]>("/public/plans?brand=conversia")
      .then((p) => {
        const elegido = elegirPlanBase(p);
        if (elegido) setBase(elegido);
      })
      .catch(() => {});
    api<Pack[]>("/public/conversation-packs?brand=conversia")
      .then((ps) => {
        if (Array.isArray(ps) && ps.length) setPacks(ps);
      })
      .catch(() => {});
  }, []);

  return derivarPrecios(base, packs);
}
