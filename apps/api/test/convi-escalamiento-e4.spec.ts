import { describe, it, expect } from "vitest";
import { AssistantService } from "../src/assistant/assistant.service";
import {
  decidirEscalamiento,
  esMotivoValido,
  mensajeDeEscalamiento,
  MOTIVOS_DE_ESCALAMIENTO,
  SLA_POR_DEFECTO,
} from "../src/assistant/escalamiento";

/**
 * E4 — ESCALAR SOLO CUANDO CORRESPONDE, Y DE VERDAD.
 *
 * Había un comodín repetido en tres lugares del prompt: «si no puedes resolver, escala». Con
 * esa instrucción y sin herramientas para actuar, el modelo escalaba todo — incluida una
 * cuenta vencida, que se resuelve con un botón de pago.
 *
 * Y el mensaje era falso: `escalarAHumano` creaba un ticket y **no le avisaba a nadie**. «He
 * informado tu caso al equipo» era, literalmente, una frase.
 */

describe("la lista es CERRADA", () => {
  it("tiene exactamente los cinco motivos acordados", () => {
    expect([...MOTIVOS_DE_ESCALAMIENTO].sort()).toEqual(
      ["disputa_de_cobro", "inconsistencia_interna", "pidio_una_persona", "restriccion_whatsapp", "verificacion_meta"].sort(),
    );
  });

  it("lo que NO está en la lista no escala, y se le dice qué hacer en vez", () => {
    const d = decidirEscalamiento({ motivo: "la cuenta está vencida", consultado: ["estadoDeCuenta → vencida"] });
    expect(d.escala).toBe(false);
    expect(d.enVezDe).toMatch(/resuélvelo con las herramientas/i);
  });

  it("los casos que ANTES se escalaban y ahora se resuelven", () => {
    for (const m of ["cuenta vencida", "sin saldo", "canal sin asistente", "bot pausado", "no pude resolverlo"]) {
      expect(decidirEscalamiento({ motivo: m, consultado: ["x"] }).escala, `"${m}" no debe escalar`).toBe(false);
    }
  });

  it("un motivo vacío tampoco escala", () => {
    expect(decidirEscalamiento({ motivo: "", consultado: ["x"] }).escala).toBe(false);
    expect(esMotivoValido("")).toBe(false);
  });
});

describe("hay que haber MIRADO algo antes", () => {
  it("escalar sin diagnosticar es rendirse con otro nombre", () => {
    const d = decidirEscalamiento({ motivo: "restriccion_whatsapp", consultado: [] });
    expect(d.escala).toBe(false);
    expect(d.enVezDe).toMatch(/al menos una herramienta de diagnóstico/i);
  });

  it("con un diagnóstico hecho, sí escala", () => {
    expect(decidirEscalamiento({ motivo: "restriccion_whatsapp", consultado: ["estadoWhatsapp → restringida"] }).escala).toBe(true);
  });

  it("pedir una persona es la ÚNICA excepción: no hay nada que diagnosticar", () => {
    const d = decidirEscalamiento({ motivo: "pidio_una_persona", consultado: [] });
    expect(d.escala).toBe(true);
    expect(d.motivo).toBe("pidio_una_persona");
  });
});

describe("el mensaje dice qué intentó, qué encontró y qué sigue", () => {
  const base = {
    motivo: "restriccion_whatsapp" as const,
    codigo: "CV-1234",
    consultado: ["estadoWhatsapp → restringida", "probarCanal → 131049"],
    sla: "Te respondemos en menos de 4 horas.",
  };

  it("lleva el código del ticket: sin código, «informé al equipo» no se puede seguir", () => {
    expect(mensajeDeEscalamiento(base)).toContain("CV-1234");
  });

  it("cuenta lo que ya revisó", () => {
    expect(mensajeDeEscalamiento(base)).toContain("estadoWhatsapp");
  });

  it("lleva el plazo, que viene de la configuración y no escrito a mano", () => {
    expect(mensajeDeEscalamiento(base)).toContain("menos de 4 horas");
    expect(mensajeDeEscalamiento({ ...base, sla: null })).not.toContain("4 horas");
  });

  it("dice que sigue acompañando, no que se desentiende", () => {
    expect(mensajeDeEscalamiento(base)).toMatch(/apenas haya novedad/i);
  });

  it("cada motivo tiene su explicación, y ninguna culpa al cliente", () => {
    for (const m of MOTIVOS_DE_ESCALAMIENTO) {
      const t = mensajeDeEscalamiento({ ...base, motivo: m });
      expect(t.length).toBeGreaterThan(40);
      expect(t).not.toMatch(/tu culpa|hiciste mal/i);
    }
  });

  it("si una herramienta aún no corrió, el mensaje no inventa que revisó algo", () => {
    expect(mensajeDeEscalamiento({ ...base, consultado: [] })).not.toMatch(/Ya revisé/);
  });

  it("hay un plazo por defecto, para no quedar sin decir nada", () => {
    expect(SLA_POR_DEFECTO).toMatch(/horario hábil/i);
  });
});

describe("el prompt perdió los comodines", () => {
  const svc = new AssistantService({} as never, {} as never);
  const prompt = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    true,
    "/inicio",
  );
  const promptNoDueno = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    false,
    "/inicio",
  );

  it("ya no dice «si no puedes, escala»", () => {
    expect(prompt).not.toMatch(/si no puedes, escala/i);
  });

  it("a un no-dueño ya no le dice «NO configures nada»", () => {
    expect(promptNoDueno).not.toMatch(/NO configures nada/i);
    expect(promptNoDueno).toMatch(/pedirle la autorización al dueño|pedirle la autorizacion al dueno/i);
  });

  it("tiene la lista cerrada y dice que lo demás lo resuelve él", () => {
    expect(prompt).toMatch(/lista CERRADA/i);
    expect(prompt).toMatch(/los resuelves TU|los resuelves tú/i);
  });

  it("exige diagnosticar antes de escalar", () => {
    expect(prompt).toMatch(/al menos una herramienta de diagnostico|al menos una herramienta de diagnóstico/i);
  });

  it("prohíbe «informé al equipo» sin código de ticket", () => {
    expect(prompt).toMatch(/sin tener el codigo|sin tener el código/i);
  });
});
