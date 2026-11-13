import { describe, it, expect } from "vitest";
import { porQueNoRespondio, VENTANA_HORAS, type EntradaDelDiagnostico } from "../src/assistant/diagnostico-conversacion";

/**
 * E3.d — «¿por qué no respondió el bot?» es la pregunta que más llega, y hasta ahora la
 * respuesta de Convi era adivinar.
 *
 * Hay SEIS causas que para el dueño se ven idénticas (el cliente escribió y nadie contestó) y
 * cada una se arregla distinto: una pagando, otra asignando un asistente, otra mandando una
 * plantilla… y una no se arregla, porque es lo correcto.
 */

const AHORA = new Date("2026-11-12T12:00:00Z");
const haceHoras = (h: number) => new Date(AHORA.getTime() - h * 3_600_000);

/** Una conversación sana: todo en orden. Cada test rompe UNA cosa. */
const sana: EntradaDelDiagnostico = {
  cuentaVigente: true,
  creditos: 500,
  iaActiva: true,
  intervencionHumana: false,
  tieneAsistente: true,
  ultimoEntranteEn: haceHoras(1),
  ultimoSalienteEn: haceHoras(0.5),
  errorDelProveedor: null,
  ahora: AHORA,
};

describe("las seis causas, una por una", () => {
  it("cuenta vencida", () => {
    const d = porQueNoRespondio({ ...sana, cuentaVigente: false });
    expect(d.causa).toBe("cuenta_vencida");
    expect(d.herramienta).toBe("generarEnlaceDePago");
  });

  it("sin créditos", () => {
    const d = porQueNoRespondio({ ...sana, creditos: 0 });
    expect(d.causa).toBe("sin_creditos");
    expect(d.comoSeArregla).toMatch(/recarga/i);
  });

  it("bot pausado en la conversación", () => {
    const d = porQueNoRespondio({ ...sana, iaActiva: false });
    expect(d.causa).toBe("bot_pausado");
    expect(d.herramienta).toBe("retomarBotEnConversacion");
  });

  it("alguien del equipo la tomó — y esto NO es un problema que arreglar", () => {
    const d = porQueNoRespondio({ ...sana, intervencionHumana: true });
    expect(d.causa).toBe("intervencion_humana");
    // Decirle "arregla esto" cuando su propia gente está atendiendo sería desinformarlo.
    expect(d.comoSeArregla).toBeNull();
    expect(d.que).toMatch(/a propósito/i);
  });

  it("canal sin asistente asignado", () => {
    const d = porQueNoRespondio({ ...sana, tieneAsistente: false });
    expect(d.causa).toBe("sin_asistente");
    expect(d.herramienta).toBe("asignarAsistenteACanal");
  });

  it("fuera de la ventana de 24 h", () => {
    const d = porQueNoRespondio({ ...sana, ultimoEntranteEn: haceHoras(VENTANA_HORAS + 1), ultimoSalienteEn: null });
    expect(d.causa).toBe("fuera_de_ventana");
    expect(d.herramienta).toBe("listarPlantillasWhatsapp");
    // No es un error nuestro: es como funciona WhatsApp, y hay que decirlo así.
    expect(d.que).toMatch(/WhatsApp solo deja/i);
  });

  it("error del proveedor, con el mensaje de Meta", () => {
    const d = porQueNoRespondio({ ...sana, errorDelProveedor: "131047: ventana cerrada", ultimoSalienteEn: null });
    expect(d.causa).toBe("error_del_proveedor");
    expect(d.que).toContain("131047");
  });

  it("y el caso en que SÍ respondió", () => {
    expect(porQueNoRespondio(sana).causa).toBe("respondio");
  });
});

describe("el ORDEN importa: primero lo de más abajo", () => {
  it("con la cuenta vencida NO dice «fuera de la ventana», aunque también sea cierto", () => {
    // Las dos cosas son verdad. Pero mandar al dueño a mandar una plantilla cuando lo que
    // tiene es la cuenta detenida es hacerle perder el día.
    const d = porQueNoRespondio({
      ...sana,
      cuentaVigente: false,
      ultimoEntranteEn: haceHoras(48),
      ultimoSalienteEn: null,
    });
    expect(d.causa).toBe("cuenta_vencida");
  });

  it("sin créditos manda sobre el bot pausado", () => {
    expect(porQueNoRespondio({ ...sana, creditos: 0, iaActiva: false }).causa).toBe("sin_creditos");
  });

  it("la intervención humana manda sobre el bot pausado: explica MEJOR lo mismo", () => {
    // Tomar una conversación la pausa. Decir "está pausada" es cierto y no dice nada; decir
    // "alguien del equipo la tomó" es lo que el dueño necesita oír.
    expect(porQueNoRespondio({ ...sana, intervencionHumana: true, iaActiva: false }).causa).toBe("intervencion_humana");
  });

  it("el error del proveedor manda sobre la ventana: es el hecho concreto", () => {
    const d = porQueNoRespondio({
      ...sana,
      errorDelProveedor: "131047",
      ultimoEntranteEn: haceHoras(48),
      ultimoSalienteEn: null,
    });
    expect(d.causa).toBe("error_del_proveedor");
  });
});

describe("casos de borde que no pueden mentir", () => {
  it("una cuenta que no se cobra por créditos no se diagnostica por saldo", () => {
    expect(porQueNoRespondio({ ...sana, creditos: null }).causa).toBe("respondio");
  });

  it("justo en el límite de las 24 h todavía está DENTRO", () => {
    const d = porQueNoRespondio({ ...sana, ultimoEntranteEn: haceHoras(VENTANA_HORAS), ultimoSalienteEn: null });
    expect(d.causa).not.toBe("fuera_de_ventana");
  });

  it("sin ningún mensaje entrante se trata como fuera de ventana, no como «respondió»", () => {
    const d = porQueNoRespondio({ ...sana, ultimoEntranteEn: null, ultimoSalienteEn: null });
    expect(d.causa).toBe("fuera_de_ventana");
  });

  it("un saliente ANTERIOR al último entrante no cuenta como respuesta", () => {
    const d = porQueNoRespondio({ ...sana, ultimoEntranteEn: haceHoras(1), ultimoSalienteEn: haceHoras(5) });
    expect(d.que).toMatch(/No veo nada que lo esté bloqueando/i);
    expect(d.comoSeArregla).toMatch(/escalo/i);
  });

  it("todas las causas traen una frase en castellano y sin jerga", () => {
    const casos: Array<Partial<EntradaDelDiagnostico>> = [
      { cuentaVigente: false },
      { creditos: 0 },
      { iaActiva: false },
      { intervencionHumana: true },
      { tieneAsistente: false },
      { ultimoEntranteEn: haceHoras(48), ultimoSalienteEn: null },
      { errorDelProveedor: "x", ultimoSalienteEn: null },
    ];
    for (const c of casos) {
      const d = porQueNoRespondio({ ...sana, ...c });
      expect(d.que.length).toBeGreaterThan(20);
      expect(d.que).not.toMatch(/aiEnabled|defaultAgentId|WABA|null/);
    }
  });
});
