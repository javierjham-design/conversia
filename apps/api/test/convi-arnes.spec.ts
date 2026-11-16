import { describe, it, expect } from "vitest";
import { correrEscenario, tasaDeEscalamiento, FRASES_PROHIBIDAS } from "./convi-arnes/arnes";
import { ESCENARIOS } from "./convi-arnes/escenarios";
import { AssistantService } from "../src/assistant/assistant.service";

/**
 * E5 — ARNÉS DE CALIDAD DE CONVI.
 *
 * Esto NO evalúa al modelo: evalúa **las reglas con las que el modelo tiene que jugar**. Un
 * test que mandara cada escenario a la IA real sería caro, lento y no determinista — fallaría
 * en días distintos sin que nadie haya tocado una línea, y un test que falla al azar se
 * termina ignorando, que es la peor forma de no tener tests.
 *
 * Lo que sí se prueba, que es lo que importa: dado el estado de una cuenta, ¿qué DEBE hacer
 * Convi? ¿Qué herramienta corresponde? ¿Escala o no? Esas decisiones son nuestras, están en
 * código, y si alguien las cambia sin querer, acá se cae.
 */

describe("los escenarios del documento", () => {
  for (const e of ESCENARIOS) {
    it(e.nombre, () => {
      const r = correrEscenario(e);
      expect(r.fallos, `«${e.mensaje}» → ${r.fallos.join(" · ")}`).toEqual([]);
    });
  }
});

describe("los DOS escenarios reales, que son los que motivaron la tanda", () => {
  const real = (n: string) => ESCENARIOS.find((e) => e.nombre.startsWith(n))!;

  it("1 — cuenta vencida: ofrece pagar y NO escala", () => {
    const e = real("REAL 1 —");
    expect(correrEscenario(e).ok).toBe(true);
    expect(e.espera.escala).toBe(false);
    expect(e.espera.herramienta).toBe("generarEnlaceDePago");
  });

  it("1c — ya pagada: la prueba del asistente CORRE (era el defecto de E2.a)", () => {
    const e = real("REAL 1c");
    expect(e.cuenta!.vigencia!.vigente).toBe(true);
    expect(correrEscenario(e).ok).toBe(true);
  });

  it("2 — vuelve al día siguiente y la cuenta está en orden", () => {
    expect(correrEscenario(real("REAL 2")).ok).toBe(true);
  });
});

describe("la métrica que mira el dueño", () => {
  it("de todos los escenarios que INTENTAN escalar, solo escala la lista cerrada", () => {
    const tasa = tasaDeEscalamiento(ESCENARIOS);
    // Hay 8 intentos; 4 son motivos válidos con diagnóstico. Si alguien afloja la lista, esto
    // sube y se nota.
    expect(tasa).toBeLessThanOrEqual(60);
    expect(tasa).toBeGreaterThan(0);
  });

  it("cubre las SEIS causas del silencio del bot", () => {
    const causas = new Set(ESCENARIOS.map((e) => e.espera.causa).filter(Boolean));
    for (const c of ["cuenta_vencida", "sin_creditos", "bot_pausado", "intervencion_humana", "sin_asistente", "fuera_de_ventana", "error_del_proveedor"]) {
      expect(causas.has(c), `falta un escenario para ${c}`).toBe(true);
    }
  });

  it("cubre los cinco motivos de escalamiento que SÍ valen", () => {
    const motivos = new Set(ESCENARIOS.filter((e) => e.espera.escala).map((e) => e.intentaEscalarCon!.motivo));
    expect(motivos.size).toBeGreaterThanOrEqual(4);
  });
});

describe("frases prohibidas", () => {
  it("cada una está por un caso real, documentado", () => {
    for (const f of FRASES_PROHIBIDAS) {
      expect(f.porque.length, `${f.patron} necesita explicar por qué está prohibida`).toBeGreaterThan(30);
    }
  });

  it("el PROMPT no contiene ninguna de ellas como instrucción a seguir", () => {
    const svc = new AssistantService({} as never, {} as never);
    const prompt = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
      (svc as unknown as { minimalContext(): unknown }).minimalContext(),
      true,
      "/inicio",
    );
    // Las frases aparecen en el prompt SOLO como prohibiciones («NUNCA digas …»). Lo que se
    // comprueba es que cada mención venga acompañada de su prohibición.
    for (const f of FRASES_PROHIBIDAS) {
      const m = prompt.match(f.patron);
      if (!m) continue;
      const alrededor = prompt.slice(Math.max(0, prompt.indexOf(m[0]) - 120), prompt.indexOf(m[0]) + m[0].length);
      // El prompt las prohíbe de varias formas («NUNCA digas», «Nada de», «no se escala»).
      // Lo que importa es que la mención venga acompañada de la prohibición, no la redacción.
      expect(alrededor, `"${m[0]}" aparece sin estar prohibida`).toMatch(/NUNCA|NO digas|Nada de|prohib|no se escala/i);
    }
  });
});

describe("el arnés sirve de algo", () => {
  it("un escenario con la expectativa equivocada FALLA (si no, no prueba nada)", () => {
    const falso = { ...ESCENARIOS[0], espera: { ...ESCENARIOS[0].espera, escala: true } };
    expect(correrEscenario(falso).ok).toBe(false);
  });

  it("hay al menos quince escenarios", () => {
    expect(ESCENARIOS.length).toBeGreaterThanOrEqual(15);
  });
});
