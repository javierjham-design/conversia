import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARDIÁN — ningún `jobId` que BullMQ vaya a RECHAZAR.
 *
 * Caso real (prod, 2026-11-02). Los logs de la api tiraban, cada pocos minutos:
 * `POST /webhooks/meta-crm :: Custom Id cannot contain :`. El webhook de Lead Ads encolaba con
 * `jobId = "meta-crm:<hash>"` y **cada lead de Meta se perdía** (la excepción sale DESPUÉS de
 * verificar la firma, así que el lead ya estaba aceptado y nunca llegó al CRM).
 *
 * Lo que lo hizo difícil de ver es la regla de BullMQ, que no es "sin dos puntos":
 *
 *   // bullmq 5.81.2 — dist/cjs/classes/job.js
 *   // TODO: replace this check in next breaking check with include(':')
 *   if (opts.jobId.includes(':') && opts.jobId.split(':').length !== 3)
 *     throw new Error('Custom Id cannot contain :');
 *
 * O sea: **CERO dos-puntos pasa, DOS pasan (compatibilidad con los jobs repetibles viejos), y
 * UNO revienta.** Por eso `turn:<conv>:<bucket>` funciona perfecto y los bots nunca fallaron,
 * mientras `meta-crm:<hash>`, `broadcast:<id>`, `retry:<runId>` y `catalog_embed:<org>` tiraban
 * excepción — uno de ellos en silencio, porque su `add()` termina en `.catch(() => undefined)`.
 *
 * Y por qué los tests no lo cazaron: los dobles de cola de la suite guardan `opts` y no validan
 * nada. `test/whatsapp-ownership.spec.ts` llegaba a **afirmar el formato roto**
 * (`/^meta-crm:[0-9a-f]{32}$/`): un doble que no valida como el de verdad convierte el test en
 * cómplice del bug. De ahí este guardián, que mira el CÓDIGO y no depende de ningún doble.
 *
 * ⚠️ Al subir a BullMQ 6: ese TODO dice que la regla pasa a ser `include(':')` pelado, y ese día
 * los `a:b:c` que hoy son legales (`turn:`, `turn-retry:`, `wa:`, `catalog_webhook:`) dejan de
 * serlo. Cuando se bombee la versión, cambiar `jobIdAceptadoPorBullmq` por "sin dos puntos" y
 * arreglar lo que este test marque.
 */

const RAIZ = join(__dirname, "..", "..", "..");

/** La regla EXACTA de bullmq 5.81.2 (`Job.addJob`), puesta en una función para poder probarla. */
export function jobIdAceptadoPorBullmq(jobId: string): boolean {
  if (`${parseInt(jobId, 10)}` === jobId) return false; // "Custom Id cannot be integers"
  if (jobId.includes(":") && jobId.split(":").length !== 3) return false;
  return true;
}

describe("la regla de BullMQ, tal cual", () => {
  it("sin dos puntos: pasa", () => {
    expect(jobIdAceptadoPorBullmq("meta-crm-abc123")).toBe(true);
    expect(jobIdAceptadoPorBullmq("wa-token-health-recheck")).toBe(true);
  });
  it("UN dos puntos: RECHAZADO (el bug)", () => {
    expect(jobIdAceptadoPorBullmq("meta-crm:abc123")).toBe(false);
    expect(jobIdAceptadoPorBullmq("broadcast:ckx1")).toBe(false);
  });
  it("DOS dos puntos: pasa (compatibilidad con repetibles viejos)", () => {
    expect(jobIdAceptadoPorBullmq("turn:conv_1:12345")).toBe(true);
  });
  it("TRES o más: RECHAZADO", () => {
    expect(jobIdAceptadoPorBullmq("a:b:c:d")).toBe(false);
  });
  it("un id que es un entero: RECHAZADO", () => {
    expect(jobIdAceptadoPorBullmq("12345")).toBe(false);
    expect(jobIdAceptadoPorBullmq("12345-abc")).toBe(true);
  });
});

interface Sitio {
  archivo: string;
  linea: number;
  plantilla: string;
}

/** Todos los `.ts` de código fuente (sin tests, sin dist, sin node_modules). */
function fuentes(dir: string, salida: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === "node_modules" || entrada === "dist" || entrada === ".next" || entrada === ".turbo") continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) fuentes(ruta, salida);
    else if (/\.tsx?$/.test(entrada) && !/\.(spec|test)\.tsx?$/.test(entrada)) salida.push(ruta);
  }
  return salida;
}

/**
 * Busca `jobId: <literal>` y `const jobId = <literal>` (las dos formas que usa el repo).
 *
 * Limitación declarada: un jobId armado en varios pasos o guardado en otra variable NO se ve.
 * Es un escáner de texto, igual que el de alcance por marca (`platform-brand-scope.spec.ts`):
 * cubre lo que se escribe en la práctica sin depender de que nadie registre nada en una lista.
 */
function sitiosDeJobId(): Sitio[] {
  const archivos = [join(RAIZ, "apps"), join(RAIZ, "packages")].flatMap((d) => fuentes(d));
  const re = /\bjobId\s*[:=]\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
  const sitios: Sitio[] = [];
  for (const archivo of archivos) {
    const src = readFileSync(archivo, "utf8");
    src.split("\n").forEach((linea, i) => {
      for (const m of linea.matchAll(re)) {
        sitios.push({ archivo: archivo.slice(RAIZ.length + 1).replace(/\\/g, "/"), linea: i + 1, plantilla: m[1].slice(1, -1) });
      }
    });
  }
  return sitios;
}

describe("ningún jobId del repo es de los que BullMQ rechaza", () => {
  const sitios = sitiosDeJobId();

  it("el escáner encuentra sitios (si no, el test sería vacuo)", () => {
    expect(sitios.length).toBeGreaterThan(5);
  });

  it("el escáner mira api Y worker", () => {
    const apps = new Set(sitios.map((s) => s.archivo.split("/")[1]));
    expect(apps.has("api")).toBe(true);
    expect(apps.has("worker")).toBe(true);
  });

  it("todos los jobId pasarían la validación de BullMQ", () => {
    // `${...}` se reemplaza por un valor de ejemplo SIN dos puntos: lo que nos importa es la
    // forma de la plantilla. Los ids que interpolamos son cuids, hashes y orgIds, nunca
    // valores con dos puntos.
    const malos = sitios.filter((s) => !jobIdAceptadoPorBullmq(s.plantilla.replace(/\$\{[^}]*\}/g, "x")));
    const detalle = malos.map((s) => `  ${s.archivo}:${s.linea} → \`${s.plantilla}\``).join("\n");
    expect(
      malos.map((s) => `${s.archivo}:${s.linea}`),
      `Estos jobId hacen que BullMQ tire "Custom Id cannot contain :" y el trabajo NUNCA se encola:\n${detalle}\n\n` +
        "Arreglalo dejando el id SIN dos puntos (p. ej. `meta-crm-<hash>`). Dos dos-puntos también " +
        "pasan hoy, pero es compatibilidad heredada que BullMQ ya marcó para eliminar: no agregues más.",
    ).toEqual([]);
  });
});
