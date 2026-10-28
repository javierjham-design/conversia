import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { COPILOT_TARGETS, NAVIGATE_ALLOWED } from "../src/assistant/actions";
import {
  accionesParaPaso,
  construirHorario,
  diagnosticarCanal,
  explicarCamino,
  normalizarDia,
  normalizarHora,
  pasoConocido,
  pasoNecesitaClic,
  resumirHorario,
} from "../src/assistant/setup-logic";
import { EMPTY_SETUP_FACTS, buildSetupSteps } from "../src/onboarding/setup-checklist";

/**
 * COP 1 — el guion del montaje: a dónde acompaña el copiloto, qué camino de WhatsApp
 * recomienda y cómo entiende un horario dictado a mano. Todo decidible sin base de datos.
 *
 * Los dos primeros bloques son GUARDIANES de largo plazo: resuelven contra el árbol REAL de
 * páginas de conversia-web y contra el código de la web, así que si alguien renombra una
 * pantalla o borra un `data-copilot`, falla acá y no en la cara de un cliente.
 */

/** Sube desde el cwd hasta encontrar la carpeta de páginas de conversia-web. */
function webAppDir(): string {
  const target = join("apps", "conversia-web", "src");
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, target))) return join(dir, target);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No encontré ${target} subiendo desde ${process.cwd()}`);
}

const WEB_SRC = webAppDir();

/** Rutas reales (una por `page.tsx`), igual que el spec del checklist. */
function collectRoutes(appDir: string): string[] {
  const routes: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const isGroup = /^\(.+\)$/.test(entry.name);
        walk(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
      } else if (/^page\.(tsx|jsx|ts|js)$/.test(entry.name)) {
        routes.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(appDir, []);
  return routes;
}

/** Todo el código fuente de la web, concatenado, para buscar los `data-copilot`. */
function webSource(): string {
  let out = "";
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(entry.name)) out += readFileSync(p, "utf8");
    }
  };
  walk(WEB_SRC);
  return out;
}

describe("las rutas a las que el copiloto puede navegar EXISTEN", () => {
  const rutas = collectRoutes(join(WEB_SRC, "app"));

  it("el árbol de rutas se leyó de verdad", () => {
    expect(rutas.length).toBeGreaterThan(10);
    expect(rutas).toContain("/inicio");
  });

  it("cada ruta de la lista blanca tiene su page.tsx", () => {
    const rotas = (NAVIGATE_ALLOWED as readonly string[]).filter((r) => !rutas.includes(r));
    expect(rotas).toEqual([]);
  });
});

describe("los elementos que el copiloto puede resaltar ESTÁN en la web", () => {
  const fuente = webSource();

  it("la fuente se leyó de verdad", () => {
    expect(fuente).toContain("data-copilot");
  });

  it("cada data-copilot de la lista está puesto en alguna pantalla", () => {
    const faltan = (COPILOT_TARGETS as readonly string[]).filter((t) => !fuente.includes(`data-copilot="${t}"`));
    expect(faltan).toEqual([]);
  });
});

describe("acompañar un paso del montaje", () => {
  it("lleva a la pantalla y resalta qué tocar", () => {
    expect(accionesParaPaso("negocio")).toEqual([
      { type: "navigate", to: "/ajustes" },
      { type: "highlight", target: "negocio-datos", text: expect.any(String) },
    ]);
  });

  it("NO navega si el cliente ya está en esa pantalla, pero sí resalta", () => {
    const out = accionesParaPaso("negocio", "/ajustes");
    expect(out.map((a) => a.type)).toEqual(["highlight"]);
  });

  it("ignora la query de la ruta actual al comparar", () => {
    expect(accionesParaPaso("pago", "/cobros?pago=ok").map((a) => a.type)).toEqual(["highlight"]);
  });

  it("un paso sin elemento que señalar solo navega (no promete un resaltado que no existe)", () => {
    expect(accionesParaPaso("asistente")).toEqual([{ type: "navigate", to: "/inicio" }]);
  });

  it("un paso desconocido no devuelve nada y se reconoce como desconocido", () => {
    expect(accionesParaPaso("inventado")).toEqual([]);
    expect(pasoConocido("inventado")).toBe(false);
    expect(pasoConocido("negocio")).toBe(true);
  });

  it("TODOS los pasos del checklist único tienen pantalla a la que acompañar", () => {
    const pasos = [
      ...buildSetupSteps({ ...EMPTY_SETUP_FACTS, agendaModule: true }),
      ...buildSetupSteps({ ...EMPTY_SETUP_FACTS, agendaModule: false }),
    ]
      .filter((s) => s.blocking || s.key === "mini_sitio")
      .map((s) => s.key);
    const sinPantalla = [...new Set(pasos)].filter((k) => !pasoConocido(k));
    expect(sinPantalla).toEqual([]);
  });

  it("pagar y conectar WhatsApp son los dos pasos que exigen el clic del dueño", () => {
    expect(pasoNecesitaClic("whatsapp")).toBe("whatsapp");
    expect(pasoNecesitaClic("pago")).toBe("pago");
    expect(pasoNecesitaClic("servicios")).toBeNull();
  });
});

describe("diagnóstico de WhatsApp", () => {
  const base = { activos: 0, sinAgente: 0, yaAtiendePorWhatsapp: false, ultimoError: null };

  it("un canal conectado SIN asistente es lo primero que avisa (recibe y nadie contesta)", () => {
    expect(diagnosticarCanal({ ...base, activos: 1, sinAgente: 1 })).toBe("asignar_agente");
  });

  it("gana sobre cualquier otra señal, incluido un error viejo", () => {
    expect(diagnosticarCanal({ ...base, activos: 1, sinAgente: 1, ultimoError: "algo falló", yaAtiendePorWhatsapp: true })).toBe("asignar_agente");
  });

  it("sin canal y con error, explica el error antes de proponer caminos", () => {
    expect(diagnosticarCanal({ ...base, ultimoError: "Meta rechazó el número" })).toBe("revisar_error");
  });

  it("si ya atiende por WhatsApp, recomienda conservar su número", () => {
    expect(diagnosticarCanal({ ...base, yaAtiendePorWhatsapp: true })).toBe("coexistencia");
  });

  it("sin nada, ofrece los dos caminos", () => {
    expect(diagnosticarCanal(base)).toBe("numero_nuevo");
  });

  it("con el canal andando, dice que está listo", () => {
    expect(diagnosticarCanal({ ...base, activos: 1 })).toBe("listo");
  });

  it("cada camino tiene una explicación sin jerga", () => {
    for (const c of ["asignar_agente", "revisar_error", "listo", "coexistencia", "numero_nuevo"] as const) {
      const t = explicarCamino(c);
      expect(t.length).toBeGreaterThan(20);
      expect(t).not.toMatch(/WABA|defaultAgentId|phone_number_id/i);
    }
  });
});

describe("entender el horario que dicta el dueño", () => {
  it("normaliza los días como los dice una persona", () => {
    expect(normalizarDia("lunes")).toBe("mon");
    expect(normalizarDia("Lun.")).toBe("mon");
    expect(normalizarDia("MIÉRCOLES")).toBe("wed");
    expect(normalizarDia("sáb")).toBe("sat");
    expect(normalizarDia("cualquiera")).toBeNull();
  });

  it("normaliza las horas como las dice una persona", () => {
    expect(normalizarHora("9")).toBe("09:00");
    expect(normalizarHora("9:30")).toBe("09:30");
    expect(normalizarHora("09.00")).toBe("09:00");
    expect(normalizarHora("18")).toBe("18:00");
    expect(normalizarHora("6pm")).toBe("18:00");
    expect(normalizarHora("12am")).toBe("00:00");
  });

  it("rechaza una hora que no existe en vez de guardarla", () => {
    expect(normalizarHora("25:00")).toBeNull();
    expect(normalizarHora("10:75")).toBeNull();
    expect(normalizarHora("tarde")).toBeNull();
  });

  it("arma el horario en el formato que guarda la organización", () => {
    const { hours, descartados } = construirHorario([
      { dia: "lunes", desde: "9", hasta: "18" },
      { dia: "martes", desde: "09:00", hasta: "18:00" },
    ]);
    expect(hours).toEqual({ mon: [{ from: "09:00", to: "18:00" }], tue: [{ from: "09:00", to: "18:00" }] });
    expect(descartados).toEqual([]);
  });

  it("soporta el negocio que cierra a mediodía (dos tramos, ordenados)", () => {
    const { hours } = construirHorario([
      { dia: "lun", desde: "15", hasta: "19" },
      { dia: "lun", desde: "9", hasta: "13" },
    ]);
    expect(hours.mon).toEqual([{ from: "09:00", to: "13:00" }, { from: "15:00", to: "19:00" }]);
  });

  it("DESCARTA y avisa el tramo que cierra antes de abrir (deja el día sin horas)", () => {
    const { hours, descartados } = construirHorario([{ dia: "lun", desde: "18", hasta: "9" }]);
    expect(hours.mon).toBeUndefined();
    expect(descartados[0]).toMatch(/cierra antes de abrir/);
  });

  it("descarta lo que no entiende y lo informa, en vez de guardar medio horario en silencio", () => {
    const { hours, descartados } = construirHorario([
      { dia: "lun", desde: "9", hasta: "18" },
      { dia: "lunez", desde: "9", hasta: "18" },
      { dia: "mar", desde: "mañana", hasta: "tarde" },
    ]);
    expect(Object.keys(hours)).toEqual(["mon"]);
    expect(descartados).toHaveLength(2);
  });

  it("no repite un tramo idéntico ni acepta más de 4 en un día", () => {
    const { hours } = construirHorario([
      { dia: "lun", desde: "9", hasta: "10" },
      { dia: "lun", desde: "9", hasta: "10" },
    ]);
    expect(hours.mon).toHaveLength(1);
    const muchos = construirHorario(
      ["8", "10", "12", "14", "16"].map((h) => ({ dia: "lun", desde: h, hasta: String(Number(h) + 1) })),
    );
    expect(muchos.hours.mon).toHaveLength(4);
    expect(muchos.descartados[0]).toMatch(/más de 4 tramos/);
  });

  it("resume el horario de forma legible para confirmárselo al dueño", () => {
    expect(resumirHorario({ mon: [{ from: "09:00", to: "13:00" }, { from: "15:00", to: "19:00" }] })).toBe("lun 09:00-13:00 y 15:00-19:00");
    expect(resumirHorario({})).toBe("sin horario");
  });
});
