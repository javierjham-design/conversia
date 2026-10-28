import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * §6.10 / ETAPA 6 punto 7 — ALCANCE POR MARCA en /platform.
 *
 * `/platform` lo usan los super admins de LAS DOS marcas. Toda ruta que ESCRIBA tiene que
 * decidir explícitamente a qué marca alcanza: validar la marca de la fila que toca, o
 * declararse global-de-TuBot. Las que no deciden nada son el agujero de §6.5: iban por
 * `id` suelto y el admin de una marca podía editar, borrar o cobrar datos de la otra.
 *
 * Este test recorre el CÓDIGO del controlador (no los tipos) y falla si aparece una ruta
 * de escritura nueva sin ninguna de las dos cosas. Es un escáner de texto a propósito:
 * un endpoint nuevo entra por el mismo molde y queda cubierto sin que nadie se acuerde de
 * agregarlo a una lista.
 */

const CONTROLLER = join(__dirname, "..", "src", "platform", "platform.controller.ts");
const source = readFileSync(CONTROLLER, "utf8");

/** Señales de que la ruta SÍ decide su alcance por marca. */
const GUARDS = [
  "assertOrgBrand", // valida la org dueña de la fila
  "assertTubotBrand", // declarada global: solo TuBot
  "assertPackageBrand",
  "assertDemoLeadBrand",
  "assertExceptionBrand",
  "reqBrand(req)", // filtra o fija la marca del admin
  "brandOrgIds(req)", // acota a las orgs de la marca
];

/**
 * Rutas de escritura que NO necesitan marca, con el motivo. Está escrita a mano a
 * propósito: agregar una ruta acá es una decisión consciente, no un descuido.
 */
const SIN_MARCA: Record<string, string> = {
  // La marca del admin SALE de su propia sesión; no hay fila de tenant que validar.
  "POST /platform/auth/login": "autenticación del propio admin",
  // Acciones sobre el PROPIO administrador autenticado (su MFA, su contraseña).
  "POST /platform/mfa/setup": "MFA del propio admin",
  "POST /platform/mfa/enable": "MFA del propio admin",
  "POST /platform/mfa/disable": "MFA del propio admin",
  // Re-encola el MISMO barrido de salud de tokens que ya corre cada 15 min. No escribe
  // datos de ningún tenant, es idempotente (jobId fijo) y el resultado les sirve a las dos
  // marcas: es el botón "Revisar de nuevo" de Alertas.
  "POST /platform/alerts/recheck": "barrido global idempotente, no toca datos de tenant",
};

interface Ruta {
  metodo: string;
  ruta: string;
  linea: number;
  cuerpo: string;
}

/** Extrae las rutas de escritura y el cuerpo de cada handler (hasta el siguiente decorador). */
function rutasDeEscritura(src: string): Ruta[] {
  const lineas = src.split("\n");
  const decorador = /@(Post|Patch|Put|Delete)\(\s*["'`]([^"'`]*)["'`]/;
  const encontradas: Array<{ metodo: string; ruta: string; i: number }> = [];
  lineas.forEach((l, i) => {
    const m = decorador.exec(l);
    if (m) encontradas.push({ metodo: m[1].toUpperCase(), ruta: m[2], i });
  });
  // Cualquier decorador de ruta corta el cuerpo del anterior (incluidos los @Get).
  const cortes = lineas
    .map((l, i) => (/@(Get|Post|Patch|Put|Delete)\(/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  return encontradas.map(({ metodo, ruta, i }) => {
    const siguiente = cortes.find((c) => c > i) ?? lineas.length;
    return { metodo, ruta, linea: i + 1, cuerpo: lineas.slice(i, siguiente).join("\n") };
  });
}

const rutas = rutasDeEscritura(source);

describe("§6.10 — toda ruta de escritura de /platform decide su alcance por marca", () => {
  it("el escáner encuentra rutas (si no, el test sería vacuo)", () => {
    expect(rutas.length).toBeGreaterThan(20);
  });

  it("ninguna ruta de escritura queda sin guarda de marca ni exención declarada", () => {
    const sinGuarda = rutas.filter((r) => {
      const nombre = `${r.metodo} /platform/${r.ruta}`.replace(/\/+$/, "");
      if (SIN_MARCA[nombre]) return false;
      return !GUARDS.some((g) => r.cuerpo.includes(g));
    });
    const detalle = sinGuarda.map((r) => `  ${r.metodo} ${r.ruta || "(raíz)"} — platform.controller.ts:${r.linea}`).join("\n");
    expect(
      sinGuarda.map((r) => `${r.metodo} ${r.ruta}`),
      `Rutas de escritura sin alcance por marca:\n${detalle}\n\n` +
        "Arreglalo con una de estas: validar la fila (assertOrgBrand/assertPackageBrand/...), " +
        "declararla global de TuBot (assertTubotBrand), filtrar por reqBrand(req), " +
        "o agregarla a SIN_MARCA en este test CON su motivo.",
    ).toEqual([]);
  });
});
