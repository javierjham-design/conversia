import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LA HORA LOCAL SALE DE LA ZONA DE LA CUENTA, NO DE UN OFFSET ESCRITO A MANO.
 *
 * El motor de disponibilidad ya tiene sus propios tests de comportamiento
 * (`packages/scheduling/src/zona-chile.test.ts`): ahí se comprueba que un negocio de
 * 09:00 a 19:00 reciba ofertas de 09:00 a 19:00 en el reloj de Chile, en verano y en
 * invierno, y que un rango que cruza el cambio de hora resuelva CADA día por separado.
 *
 * Lo que esos tests NO pueden ver es el otro lado: los PUNTOS DE LLAMADA. El bug original
 * no estaba en el motor —el motor aceptaba una zona— sino en que cada llamador le pasaba
 * `offset: "-04:00"` escrito a mano. Había cuatro, y bastaba con que uno volviera a
 * escribirlo para que el panel y el bot ofrecieran horas distintas.
 *
 * Por eso esto escanea los archivos de los llamadores. Se escanea el código SIN COMENTARIOS
 * a propósito: las explicaciones del bug nombran "-04:00" y no son el bug.
 */

const raiz = join(__dirname, "..", "..", ".."); // apps/api/test → repo
const leer = (...partes: string[]): string => readFileSync(join(raiz, ...partes), "utf8");

/** Código sin comentarios: lo que de verdad corre. */
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]+\/\/[^"'`\n]*$/gm, "");

/** Rebanada exacta entre dos marcas, con el mismo cuidado que en el resto del repo. */
const trozo = (src: string, desdeTxt: string, hastaTxt: string, nombre: string): string => {
  const desde = src.indexOf(desdeTxt);
  const hasta = src.indexOf(hastaTxt, desde + 1);
  expect(desde, `no se encontró el inicio de ${nombre}`).toBeGreaterThan(-1);
  expect(hasta, `no se encontró el final de ${nombre}`).toBeGreaterThan(desde);
  const t = src.slice(desde, hasta);
  expect(t.length, `la rebanada de ${nombre} salió vacía`).toBeGreaterThan(200);
  return t;
};

const TOOL_SERVICES = sinComentarios(leer("apps", "worker", "src", "tool-services.ts"));
const AGENDA_CTRL = sinComentarios(leer("apps", "api", "src", "scheduling", "agenda.controller.ts"));
const SANDBOX = sinComentarios(leer("apps", "api", "src", "agents", "agent-sandbox.ts"));
const INTEGRACIONES = sinComentarios(leer("apps", "api", "src", "integrations", "integrations.controller.ts"));
const MOTOR = sinComentarios(leer("packages", "scheduling", "src", "availability.ts"));

/** Los cuatro que construyen una agenda, cada uno con el trozo que le toca. */
const LLAMADORES: Array<[string, string]> = [
  ["bot (agenda nativa)", trozo(TOOL_SERVICES, "return new NativeSchedulingProvider({", "export interface ToolTargets", "bot nativo")],
  // Las marcas son CÓDIGO, no comentarios: `sinComentarios` ya se los llevó.
  ["bot (Dentalink)", trozo(TOOL_SERVICES, 'if (kind === "DENTALINK" && connection)', "const data = await withTenant(orgId", "bot dentalink")],
  ["panel (horas libres)", trozo(AGENDA_CTRL, "const free = computeNativeSlots({", "return { source:", "panel")],
  ["probador de agentes", trozo(SANDBOX, "new MockSchedulingProvider({", "withAppointmentDuration", "probador")],
];

describe("ningún llamador escribe el offset a mano", () => {
  it.each(LLAMADORES)("el %s no lleva un offset fijo", (quien, bloque) => {
    expect(bloque, `el ${quien} volvió a escribir un offset de Chile a mano`).not.toMatch(/-0[34]:00/);
  });

  it.each(LLAMADORES)("el %s declara la ZONA de la cuenta", (quien, bloque) => {
    expect(bloque, `el ${quien} tiene que pasar timeZone`).toContain("timeZone:");
    expect(bloque, `el ${quien} tiene que sacar la zona de la cuenta, no inventarla`).toMatch(/timezone \|\| ZONA_POR_DEFECTO|timezone \?\? ZONA_POR_DEFECTO|timeZone: this\.opts\.timeZone/);
  });
});

describe("no queda aritmética de offsets duplicada", () => {
  it("el panel usa el helper compartido para la medianoche local", () => {
    // Antes: `startOfLocalDay(offset)` parseaba "-04:00" a mano en el controlador.
    expect(AGENDA_CTRL).not.toContain("startOfLocalDay");
    expect(AGENDA_CTRL).toContain("inicioDelDiaEnZona(");
  });

  it("nadie lee ya un offset guardado en settings.agenda ni en la conexión", () => {
    // Un offset en la base no puede saber del cambio de hora: la zona sí.
    for (const [quien, src] of [["bot", TOOL_SERVICES], ["panel", AGENDA_CTRL]] as const) {
      expect(src, `${quien} volvió a leer un offset de la base`).not.toMatch(/agenda\.offset|cfg\.offset|cfg\.utcOffset/);
    }
  });

  it("al conectar Dentalink no se guarda un offset en la configuración", () => {
    expect(INTEGRACIONES).not.toMatch(/utcOffset: "-0[34]:00"/);
  });
});

describe("el motor resuelve el offset DÍA POR DÍA", () => {
  // La mutación que un test de comportamiento flojo no caza: resolver el offset una sola vez
  // por consulta. Anda todo el año salvo la semana del cambio de hora, que es justo cuando
  // el negocio ya está confundido.
  it("usa la fecha de cada día del rango, no la del inicio", () => {
    expect(MOTOR).toContain("offsetForZoneOnDate(zona, date)");
    expect(MOTOR).not.toContain("offsetForZoneOnDate(zona, input.fromDate)");
  });

  it("el motor no tiene un offset de Chile de respaldo", () => {
    expect(MOTOR).not.toMatch(/-0[34]:00/);
  });
});
