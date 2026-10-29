import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * §6.10 / ETAPA 6 punto 7 — ALCANCE POR MARCA en /platform.
 *
 * `/platform` lo usan los super admins de LAS DOS marcas. Toda ruta que ESCRIBA tiene que
 * decidir explícitamente a qué marca alcanza: validar la marca de la fila que toca, o
 * declararse global-de-TuBot. Las que no deciden nada son el agujero de §6.5: iban por
 * `id` suelto y el admin de una marca podía editar, borrar o cobrar datos de la otra.
 *
 * AJUSTE FINAL — el escáner recorre TODOS los controladores de /platform (no solo
 * `platform.controller.ts`): toma cada `*.controller.ts` del directorio y usa su propio
 * `@Controller("...")` para armar la ruta completa. Así una ruta nueva en un controlador
 * nuevo —o en `platform-auth`— entra por el mismo molde y no puede colarse sin alcance.
 *
 * Es un escáner de TEXTO a propósito: no depende de que alguien se acuerde de registrar el
 * endpoint en ninguna lista.
 */

const PLATFORM_DIR = join(__dirname, "..", "src", "platform");

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
  // Autenticación del PROPIO admin: la marca sale del Origin/sesión, no hay fila de tenant.
  "POST /platform/auth/login": "login del propio admin (marca por Origin)",
  "POST /platform/auth/google": "login con Google del propio admin (marca por Origin)",
  "POST /platform/auth/logout": "cierra la sesión del propio admin",
  "POST /platform/auth/reauth": "re-autenticación del propio admin",
  // MFA del PROPIO admin autenticado (su secreto, sus códigos de recuperación).
  "POST /platform/auth/mfa/enroll": "MFA del propio admin",
  "POST /platform/auth/mfa/verify": "MFA del propio admin",
  "POST /platform/auth/mfa/disable": "MFA del propio admin",
  // Re-encola el MISMO barrido de salud de tokens que ya corre cada 15 min. No escribe
  // datos de ningún tenant, es idempotente (jobId fijo) y el resultado les sirve a las dos
  // marcas: es el botón "Revisar de nuevo" de Alertas.
  "POST /platform/alerts/recheck": "barrido global idempotente, no toca datos de tenant",
};

interface Ruta {
  metodo: string;
  nombre: string; // "POST /platform/..."
  ruta: string; // ruta cruda del decorador (para el mensaje de error)
  archivo: string;
  linea: number;
  cuerpo: string;
}

/** Base del controlador (`@Controller("platform/auth")` → "platform/auth"); null si no tiene. */
function controllerBase(src: string): string | null {
  const m = /@Controller\(\s*["'`]([^"'`]*)["'`]/.exec(src);
  return m ? m[1].replace(/^\/+|\/+$/g, "") : null;
}

/** Une base + ruta del decorador en una ruta absoluta normalizada. */
function rutaAbsoluta(base: string, ruta: string): string {
  return ("/" + base + "/" + ruta).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

/** Extrae las rutas de escritura y el cuerpo de cada handler (hasta el siguiente decorador). */
function rutasDeEscritura(src: string, base: string, archivo: string): Ruta[] {
  const lineas = src.split("\n");
  const decorador = /@(Post|Patch|Put|Delete)\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/;
  const encontradas: Array<{ metodo: string; ruta: string; i: number }> = [];
  lineas.forEach((l, i) => {
    const m = decorador.exec(l);
    if (m) encontradas.push({ metodo: m[1].toUpperCase(), ruta: m[2] ?? "", i });
  });
  // Cualquier decorador de ruta corta el cuerpo del anterior (incluidos los @Get).
  const cortes = lineas
    .map((l, i) => (/@(Get|Post|Patch|Put|Delete)\(/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  return encontradas.map(({ metodo, ruta, i }) => {
    const siguiente = cortes.find((c) => c > i) ?? lineas.length;
    return {
      metodo,
      ruta,
      nombre: `${metodo} ${rutaAbsoluta(base, ruta)}`,
      archivo,
      linea: i + 1,
      cuerpo: lineas.slice(i, siguiente).join("\n"),
    };
  });
}

// TODOS los controladores de /platform, no solo el principal.
const archivos = readdirSync(PLATFORM_DIR).filter((f) => f.endsWith(".controller.ts"));
const rutas: Ruta[] = [];
for (const archivo of archivos) {
  const src = readFileSync(join(PLATFORM_DIR, archivo), "utf8");
  const base = controllerBase(src);
  if (!base || !base.startsWith("platform")) continue; // solo controladores de /platform
  rutas.push(...rutasDeEscritura(src, base, archivo));
}

describe("§6.10 — toda ruta de escritura de /platform decide su alcance por marca", () => {
  it("el escáner cubre más de un controlador de /platform", () => {
    expect(new Set(rutas.map((r) => r.archivo)).size).toBeGreaterThan(1);
  });

  it("el escáner encuentra rutas (si no, el test sería vacuo)", () => {
    expect(rutas.length).toBeGreaterThan(20);
  });

  it("cubre las rutas de las features nuevas (excepciones)", () => {
    const nombres = rutas.map((r) => r.nombre);
    expect(nombres).toContain("POST /platform/exceptions/:id/assign");
    expect(nombres).toContain("POST /platform/exceptions/:id/resolve");
  });

  it("ninguna ruta de escritura queda sin guarda de marca ni exención declarada", () => {
    const sinGuarda = rutas.filter((r) => {
      if (SIN_MARCA[r.nombre]) return false;
      return !GUARDS.some((g) => r.cuerpo.includes(g));
    });
    const detalle = sinGuarda.map((r) => `  ${r.nombre || "(raíz)"} — ${r.archivo}:${r.linea}`).join("\n");
    expect(
      sinGuarda.map((r) => r.nombre),
      `Rutas de escritura sin alcance por marca:\n${detalle}\n\n` +
        "Arreglalo con una de estas: validar la fila (assertOrgBrand/assertPackageBrand/...), " +
        "declararla global de TuBot (assertTubotBrand), filtrar por reqBrand(req), " +
        "o agregarla a SIN_MARCA en este test CON su motivo.",
    ).toEqual([]);
  });
});
