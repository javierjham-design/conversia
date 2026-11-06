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

type Flotante = { archivo: string; linea: number; bottom: number };

/** Todo lo `position: fixed` con un `bottom` numérico (los modales `inset: 0` no cuentan). */
function flotantesAbajo(): Flotante[] {
  const raiz = join(__dirname, "..");
  const encontrados: Flotante[] = [];
  for (const archivo of tsx(raiz)) {
    const src = readFileSync(archivo, "utf8");
    const re = /position:\s*"fixed"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // El mismo literal de estilo, a grandes rasgos: lo que rodea a la declaración.
      const trozo = src.slice(Math.max(0, m.index - 220), m.index + 220);
      if (/inset:\s*0/.test(trozo)) continue; // modal a pantalla completa, con velo propio
      const b = /bottom:\s*(\d+)\b/.exec(trozo);
      if (!b) continue;
      encontrados.push({
        archivo: relative(join(raiz, ".."), archivo).replace(/\\/g, "/"),
        linea: src.slice(0, m.index).split("\n").length,
        bottom: Number(b[1]),
      });
    }
  }
  return encontrados;
}

describe("nada flotante tapa la barra de pestañas", () => {
  it("no hay elementos fijos apoyados dentro de los 62px de la barra", () => {
    const estorbos = flotantesAbajo().filter((e) => e.bottom < ALTO_BARRA);
    const detalle = estorbos.map((e) => `${e.archivo}:${e.linea} (bottom: ${e.bottom})`).join("\n");
    expect(estorbos.length, `tapan la navegación en teléfono:\n${detalle}`).toBe(0);
  });

  it("el detector encuentra de verdad lo que flota abajo", () => {
    // Si el regex dejara de calzar, el test de arriba quedaría verde por no mirar nada.
    // Hoy flotan abajo la hoja "Más" (76) y la burbuja de Convi (78), las dos POR ENCIMA.
    const flotan = flotantesAbajo();
    expect(flotan.length, "el detector no encontró ningún flotante: ¿cambió la forma de escribirlos?").toBeGreaterThanOrEqual(2);
    expect(flotan.map((f) => f.bottom).sort((a, b) => a - b)).toEqual([76, 78]);
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
