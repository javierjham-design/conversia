/**
 * PRECIOS DE RESPALDO de la página pública y del panel.
 *
 * La página de precios y `/inicio` piden los precios al servidor. Si esa llamada no llega
 * —red del visitante, api reiniciándose, un deploy a mitad de camino— igual hay que mostrar
 * algo: una sección de precios vacía en la landing es peor que un número de hace un rato.
 *
 * El problema de un respaldo es que es el MISMO HECHO escrito dos veces: el día que el dueño
 * cambie un precio en `packages/database/seeds/creditos-catalogo.json`, este archivo queda
 * mintiendo y nadie se entera, porque solo aparece cuando algo falla — justo cuando nadie
 * está mirando. Por eso vive acá, en un solo lugar y exportado: `precios-respaldo.test.ts`
 * lo compara contra el catálogo y se cae si se separan.
 *
 * NO se importa el catálogo directamente: es un JSON del paquete de base de datos y
 * arrastrarlo al bundle del navegador mete al cliente precios de planes que no le tocan.
 * Acá van solo los números que la landing muestra.
 */

/** Plan Base: lo que se muestra mientras no llegan los precios reales. */
export const BASE_RESPALDO = { priceClp: 24_990, creditos: 300 } as const;

/** Créditos de regalo de la prueba (los muestra la landing y una pregunta frecuente). */
export const PRUEBA_RESPALDO_CREDITOS = 200;

/** Packs de recarga, en el orden en que se muestran. `bonoPct` es lo que anuncia la UI. */
export const PACKS_RESPALDO = [
  { code: "conversia-cred-420", name: "Recarga 420 créditos", credits: 420, priceClp: 24_990, bonoPct: 0 },
  { code: "conversia-cred-880", name: "Pack 880 créditos", credits: 880, priceClp: 49_900, bonoPct: 5 },
  { code: "conversia-cred-1850", name: "Pack 1.850 créditos", credits: 1850, priceClp: 99_900, bonoPct: 10 },
  { code: "conversia-cred-2900", name: "Pack 2.900 créditos", credits: 2900, priceClp: 149_900, bonoPct: 15 },
] as const;

/**
 * Créditos por conversación del estimador. El servidor lo manda junto con los packs
 * (`creditosPorConversacion`); esto es solo el respaldo, y tiene que ser el mismo número que
 * usa el medidor del panel o la landing promete un alcance distinto del que el cliente verá
 * adentro.
 */
export const CREDITOS_POR_CONVERSACION_RESPALDO = 4.5;

/** El pack que la UI destaca como "Más elegido". */
export const PACK_MAS_ELEGIDO = "conversia-cred-880";

/** El pack que la UI destaca como "Mejor precio por crédito". */
export const PACK_MEJOR_PRECIO = "conversia-cred-2900";
