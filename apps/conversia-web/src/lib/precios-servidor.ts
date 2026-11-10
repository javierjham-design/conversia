import { apiBase } from "@/lib/api-base";
import { elegirPlanBase, type CatalogoInicial, type Pack, type Plan } from "@/lib/precios-nucleo";

/**
 * Lee el catálogo ACTIVO **desde el servidor**, para que el precio salga ya en el HTML.
 *
 * El 3-nov la portada sirvió "Desde $24.990 al mes" con el plan activo cobrando $18.900: el
 * precio lo pedía solo el navegador, así que el HTML prerenderizado llevaba el estado inicial
 * —el respaldo— y recién al hidratar se corregía. Eso no es un parpadeo: es lo que ve Google,
 * lo que abre el revisor de anuncios de Meta y lo que se queda mirando cualquiera cuya llamada
 * a la API no llegue.
 *
 * Devuelve `null` cuando no se pudo confirmar nada, y entonces la página se muestra SIN
 * precio. Es a propósito: una sección sin número es honesta; un número que nadie puede
 * sostener, no — y las reglas del lanzamiento lo prohíben explícitamente.
 */

/**
 * C2 — ¿Meta ya aprobó la App Review de mensajería?
 *
 * La portada solo puede prometer Instagram y Messenger cuando la respuesta es SÍ. Mientras
 * no lo sea, decirlo sería vender algo que el cliente no va a poder usar — y las reglas del
 * lanzamiento prohíben exactamente eso. Si no se puede confirmar, se asume que NO.
 */
export async function multicanalAprobado(): Promise<boolean> {
  const cfg = await pedir<{ messagingReviewApproved?: boolean }>("/public/meta-config?brand=conversia");
  return cfg?.messagingReviewApproved === true;
}

/** Tope de espera: la portada no se cuelga por una api lenta, se renderiza sin precio. */
const ESPERA_MS = 2_500;
/** Cada cuánto se vuelve a leer el catálogo (ISR). Un go-live se ve sin desplegar. */
export const REVALIDAR_SEGUNDOS = 300;

async function pedir<T>(ruta: string): Promise<T | null> {
  try {
    const res = await fetch(`${apiBase()}${ruta}`, {
      signal: AbortSignal.timeout(ESPERA_MS),
      next: { revalidate: REVALIDAR_SEGUNDOS },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function leerCatalogo(): Promise<CatalogoInicial | null> {
  const [planes, packs] = await Promise.all([
    pedir<Plan[]>("/public/plans?brand=conversia"),
    pedir<Pack[]>("/public/conversation-packs?brand=conversia"),
  ]);
  const base = elegirPlanBase(planes);
  // Sin el plan Base no hay precio que mostrar: devolver los packs solos dejaría la tarjeta de
  // recargas hablando de una unidad que todavía no sabemos cuál es.
  if (!base) return null;
  return { base, packs: Array.isArray(packs) ? packs : [] };
}
