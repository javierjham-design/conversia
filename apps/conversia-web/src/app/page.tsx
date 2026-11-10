import { leerCatalogo, multicanalAprobado } from "@/lib/precios-servidor";
import { Landing } from "./landing";

/**
 * Portada — componente de SERVIDOR, y lo único que hace es leer el catálogo activo antes de
 * renderizar. El texto está en `./landing.tsx`.
 *
 * Por qué no es todo cliente, como antes: la portada se prerenderiza, así que el HTML que se
 * sirve lleva el ESTADO INICIAL del hook de precios. Con el precio pedido solo desde el
 * navegador, ese HTML salía con el respaldo —y el 3-nov eso significó servir "Desde $24.990
 * al mes" mientras el plan activo cobraba $18.900—. El HTML es lo que indexa Google y lo que
 * abre el revisor de anuncios de Meta: el precio tiene que ser correcto AHÍ, no un instante
 * después.
 *
 * `revalidate` deja que un go-live de precios se vea sin desplegar nada (y el cliente además
 * vuelve a pedirlo al hidratar). Si la lectura falla, `leerCatalogo` devuelve `null` y la
 * página se muestra sin precio, que es lo honesto.
 *
 * El 300 va escrito: Next exige un literal acá (con un identificador importado el build falla
 * con "Unknown identifier at revalidate"). `precios-servidor.test.ts` verifica que sea el
 * mismo número que `REVALIDAR_SEGUNDOS`, para que no se separen.
 */
export const revalidate = 300;

export default async function Page() {
  // C2 — las dos lecturas van juntas: la portada se prerenderiza, así que tanto el precio
  // como lo que se promete tienen que ser correctos EN EL HTML, no un instante después.
  const [inicial, multicanal] = await Promise.all([leerCatalogo(), multicanalAprobado()]);
  return <Landing inicial={inicial} multicanal={multicanal} />;
}
