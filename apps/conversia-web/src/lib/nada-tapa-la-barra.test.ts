import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NADA FLOTANTE PUEDE PISAR LA BARRA DE PESTAÑAS.
 *
 * En un teléfono esa barra (`nav.shell-tabs`: 62px de alto pegada abajo, z-index 20) es la
 * ÚNICA navegación que hay. Cualquier cosa `position: fixed` apoyada más abajo de 62px la
 * tapa — y como queda *visible*, el fallo no se ve mirando la pantalla: se ve cuando
 * intentas tocar y el toque se lo come otro elemento.
 *
 * Pasó dos veces el mismo día:
 *  1. El aviso "Instala Conversia" (`PwaManager`) estaba a 12px del borde con z-index 60.
 *     En iPhone son INSTRUCCIONES que se muestran solas, no un prompt del sistema, así que
 *     quien no lo cerrara no podía tocar ningún ítem del menú. Lo cazó la jornada I.
 *  2. Al subirlo 62px dejó de tapar el menú y pasó a tapar el botón "Reintentar" de la
 *     tarjeta de saldo. Lo cazaron las jornadas B y H.
 *
 * Moraleja, y por eso este test: una barra fija abajo SIEMPRE tapa algo; lo único que
 * cambia es qué. El aviso terminó en el flujo del documento, donde no tapa nada.
 *
 * Qué NO cuenta como estorbo: los modales (`inset: 0`), que cubren la pantalla a propósito
 * y traen su propio velo, y los que se apoyan por encima de los 62px de la barra.
 */

const ALTO_BARRA = 62;

function tsx(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsx(p, acc);
    else if (p.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

type Flotante = { archivo: string; linea: number; quien: string; bottom: number };

/**
 * Reglas de CSS que SÍ pueden apoyarse sobre la barra, con el motivo escrito. Si alguien
 * suma una tercera tiene que justificarla acá.
 */
const PERMITIDOS: Record<string, string> = {
  ".cv-convi-panel":
    "es la hoja del chat de Convi abierta a 78dvh: ocupa la pantalla a propósito, como un " +
    "modal, y se cierra con su X o con Escape. Mientras está abierta, la conversación ES la " +
    "pantalla; la barra de abajo no hace falta.",
  ".cv-cookies":
    "el aviso de cookies NO se dibuja en el panel: `esRutaDeMarketing` lo deja solo en las " +
    "páginas públicas, donde no hay barra de pestañas. El test de abajo comprueba que esa " +
    "puerta sigue puesta — es lo único que lo mantiene fuera de la navegación del teléfono.",
};

/**
 * Todo lo que flota pegado abajo, venga de un estilo en línea o de una hoja CSS.
 *
 * Mira las dos formas a propósito: el acceso de Convi tenía su `bottom: 78` en línea y pasó
 * a una clase, y un detector que solo supiera leer estilos en línea habría dejado de mirar
 * justo la pieza que cambió — verde por no estar mirando nada, que es exactamente la forma
 * en que un guardián miente.
 */
function flotantesAbajo(): Flotante[] {
  const raiz = join(__dirname, "..");
  const encontrados: Flotante[] = [];
  for (const archivo of tsx(raiz)) {
    const src = readFileSync(archivo, "utf8");
    const rel = relative(join(raiz, ".."), archivo).replace(/\\/g, "/");
    const linea = (i: number) => src.slice(0, i).split("\n").length;

    // 1) Estilos EN LÍNEA: style={{ position: "fixed", …, bottom: 78 }}
    for (const m of src.matchAll(/position:\s*"fixed"/g)) {
      const trozo = src.slice(Math.max(0, m.index - 220), m.index + 220);
      if (/inset:\s*0/.test(trozo)) continue; // modal a pantalla completa, con velo propio
      const b = /bottom:\s*(\d+)\b/.exec(trozo);
      if (!b) continue;
      encontrados.push({ archivo: rel, linea: linea(m.index), quien: "estilo en línea", bottom: Number(b[1]) });
    }

    // 2) Reglas CSS dentro de un <style>: .loquesea { position: fixed; bottom: calc(86px + …) }
    for (const m of src.matchAll(/(^|\n)\s*([.#][\w-]+(?:[^{\n]*)?)\{([^}]*)\}/g)) {
      const selector = m[2].trim();
      const cuerpo = m[3];
      if (!/position:\s*fixed/.test(cuerpo)) continue;
      if (/inset:\s*0/.test(cuerpo)) continue;
      const b = /bottom:\s*(?:calc\(\s*)?(\d+)px/.exec(cuerpo);
      if (!b) continue;
      const clave = Object.keys(PERMITIDOS).find((c) => selector.includes(c));
      if (clave) continue;
      // Una animación de entrada que arranca más abajo hace que el elemento, mientras entra,
      // esté N píxeles por debajo de su reposo. Ese es el caso que no se ve en una captura.
      const anim = /animation:\s*([\w-]+)/.exec(cuerpo);
      const bajada = anim ? Number(new RegExp(`@keyframes ${anim[1]}\\s*\\{[^}]*?translateY\\((\\d+)px\\)`, "s").exec(src)?.[1] ?? 0) : 0;
      encontrados.push({ archivo: rel, linea: linea(m.index), quien: selector, bottom: Number(b[1]) - bajada });
    }
  }
  return encontrados;
}

describe("nada flotante tapa la barra de pestañas", () => {
  it("no hay elementos fijos apoyados dentro de los 62px de la barra", () => {
    const estorbos = flotantesAbajo().filter((e) => e.bottom < ALTO_BARRA);
    const detalle = estorbos.map((e) => `${e.archivo}:${e.linea} ${e.quien} (bottom útil: ${e.bottom})`).join("\n");
    expect(estorbos.length, `tapan la navegación en teléfono:\n${detalle}`).toBe(0);
  });

  it("el detector encuentra de verdad lo que flota abajo, en línea Y en CSS", () => {
    // Si los regex dejaran de calzar, el test de arriba quedaría verde por no mirar nada.
    const flotan = flotantesAbajo();
    expect(flotan.some((f) => f.quien === "estilo en línea"), "no encontró ningún flotante en línea").toBe(true);
    expect(flotan.some((f) => f.quien.startsWith(".")), "no encontró ninguna regla CSS fija abajo").toBe(true);
    // Y los dos de Convi, que son los que más cerca pasan de la barra.
    const nombres = flotan.map((f) => f.quien);
    expect(nombres).toContain(".cv-convi-peek");
    expect(nombres).toContain(".cv-convi-acceso");
  });

  it("descuenta la bajada de la animación de entrada, no solo el reposo", () => {
    // El caso más sutil de los tres estorbos reales: la burbuja quieta no tapaba nada
    // (bottom 70 > 62), pero su animación arranca 16px más abajo y durante 0,22 s se metía
    // sobre la barra. Un elemento que tapa solo mientras anima no sale en ninguna captura y
    // aun así se come el toque. El detector tiene que estar restando esa bajada.
    const peek = flotantesAbajo().find((f) => f.quien === ".cv-convi-peek");
    const src = readFileSync(join(__dirname, "..", "components", "SupportWidget.tsx"), "utf8");
    const reposo = Number(/\.cv-convi-peek\s*\{[^}]*?bottom:\s*calc\((\d+)px/s.exec(src)?.[1]);
    const bajada = Number(/@keyframes cvsheet\s*\{[^}]*?translateY\((\d+)px\)/s.exec(src)?.[1]);
    expect(reposo, "no se pudo leer el `bottom` de .cv-convi-peek").toBeTruthy();
    expect(bajada, "no se pudo leer la bajada de @keyframes cvsheet").toBeTruthy();
    expect(peek?.bottom, "el detector no está restando la bajada").toBe(reposo - bajada);
  });

  it("las exenciones siguen siendo ciertas", () => {
    // Una lista de exenciones que nadie comprueba es una lista de bugs futuros. El aviso de
    // cookies se apoya a 16px del borde con z-index 60 —tres veces el de la barra—, así que
    // lo ÚNICO que lo salva es no dibujarse nunca en el panel.
    const cookies = readFileSync(join(__dirname, "..", "components", "AvisoCookies.tsx"), "utf8");
    expect(cookies, "el aviso de cookies perdió la puerta de 'solo rutas de marketing'").toMatch(
      /esRutaDeMarketing\(pathname\)/,
    );
    expect(cookies).toMatch(/if \(!mostrar\) return null;/);
    // Y el panel de Convi sigue siendo una hoja que ocupa la pantalla, no una barrita.
    const widget = readFileSync(join(__dirname, "..", "components", "SupportWidget.tsx"), "utf8");
    expect(widget).toMatch(/\.cv-convi-panel \{[^}]*height: min\(78dvh/);
  });

  it("el aviso de la PWA no flota: va en el flujo", () => {
    const src = readFileSync(join(__dirname, "..", "components", "PwaManager.tsx"), "utf8");
    expect(src, "volvió a flotar").not.toContain('position: "fixed"');
    // Y se dibuja dentro del cuerpo del panel, no suelto al final del shell.
    const shell = readFileSync(join(__dirname, "..", "components", "AppShell.tsx"), "utf8");
    const cuerpo = shell.indexOf('<div className="shell-body">');
    const cierre = shell.indexOf("</div>", shell.indexOf("{children}"));
    const pwa = shell.indexOf("<PwaManager />");
    expect(pwa, "no se dibuja PwaManager").toBeGreaterThan(-1);
    expect(pwa > cuerpo && pwa < cierre, "PwaManager quedó fuera del cuerpo del panel").toBe(true);
  });

});
