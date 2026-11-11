import { describe, it, expect } from "vitest";
import { diagnosticarCuenta } from "../src/assistant/setup-logic";
import { setupToolSpecs, SETUP_TOOL_NAMES, isSetupWriteTool } from "../src/assistant/setup-tools";
import { AssistantService } from "../src/assistant/assistant.service";
import { evaluarVigencia } from "@conversia/agents";

/**
 * «No me deja avanzar» — Convi tiene que mirar la CUENTA, no solo el canal.
 *
 * El caso real: el dueño no podía conectar su WhatsApp, le preguntó a Convi, Convi revisó los
 * canales (lo único que sabía mirar), no encontró nada y contestó genérico. El bloqueo estaba
 * en la cuenta: vigencia vencida con el plan pagado, y el 403 llegaba antes de mirar el límite.
 */

const PLAN_OK = { code: "conversia_creditos_base", name: "Base", brand: "conversia", priceClp: 24990, active: true };

describe("la herramienta está declarada bien", () => {
  it("existe y es de LECTURA (no escribe nada en la cuenta)", () => {
    const specs = setupToolSpecs();
    expect(specs.read.some((s) => s.name === "estadoDeCuenta")).toBe(true);
    expect(specs.write.some((s) => s.name === "estadoDeCuenta")).toBe(false);
    expect(SETUP_TOOL_NAMES.has("estadoDeCuenta")).toBe(true);
    expect(isSetupWriteTool("estadoDeCuenta")).toBe(false);
  });

  it("su nombre es ASCII: un nombre con tilde o ñ hace que OpenAI rechace la petición ENTERA", () => {
    for (const s of [...setupToolSpecs().read, ...setupToolSpecs().write]) {
      expect(s.name, `${s.name} debe ser ASCII`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("su descripción le dice al modelo CUÁNDO usarla", () => {
    const spec = setupToolSpecs().read.find((s) => s.name === "estadoDeCuenta")!;
    expect(spec.description.toLowerCase()).toContain("no los deja");
    expect(spec.description.toLowerCase()).toContain("antes de responder");
  });
});

describe("el caso que lo pidió: vigencia vencida con el plan PAGADO", () => {
  const vigencia = evaluarVigencia({
    validUntil: "2026-11-02T23:57:37.944Z",
    suscripcion: { status: "ACTIVE", periodEnd: new Date(Date.now() + 30 * 86400000) },
  });

  it("la MISMA regla del 403 dice que sí está vigente → la cuenta no se bloquea", () => {
    // Si esto cambia, es que el fix de vigencia se revirtió y Convi explicaría lo que no es.
    expect(vigencia.vigente).toBe(true);
    const d = diagnosticarCuenta({ orgStatus: "ACTIVE", orgBrand: "conversia", vigencia, plan: PLAN_OK, suscripcion: { status: "ACTIVE", periodEnd: new Date(Date.now() + 30 * 86400000).toISOString() } });
    expect(d.puedeCrear).toBe(true);
  });

  it("si AÚN estuviera bloqueada, NO le pide pagar algo que ya pagó", () => {
    const d = diagnosticarCuenta({
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: false, motivo: "vencida", validUntil: "2026-11-02T23:57:37.944Z", cubiertoHasta: null },
      plan: PLAN_OK,
      suscripcion: { status: "ACTIVE", periodEnd: new Date(Date.now() + 30 * 86400000).toISOString() },
    });
    expect(d.puedeCrear).toBe(false);
    const b = d.bloqueos[0];
    expect(b.loResuelveElEquipo).toBe(true);
    expect(b.comoSeArregla).toBeNull(); // nada que hacer del lado del cliente
    expect(b.que).toContain("plan está al día");
    // Lo que importa es que NINGUNA instrucción al cliente le pida pagar o renovar. La causa
    // sí puede nombrar la renovación («no se actualizó al renovar el plan»): eso es explicar
    // por qué pasó, no mandarlo a pagar de nuevo.
    for (const x of d.bloqueos) {
      expect(x.comoSeArregla ?? "").not.toMatch(/renov|pag|regulariz/i);
    }
    expect(d.resumen).toContain("del lado nuestro");
  });
});

describe("lo que sí es del cliente se le dice como tal", () => {
  it("vencida de verdad (sin período pagado) → se le pide renovar", () => {
    const d = diagnosticarCuenta({
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: false, motivo: "vencida", validUntil: "2026-09-02T00:00:00.000Z", cubiertoHasta: null },
      plan: PLAN_OK,
      suscripcion: { status: "ACTIVE", periodEnd: "2026-09-26T03:34:18.000Z" },
    });
    expect(d.puedeCrear).toBe(false);
    expect(d.bloqueos[0].loResuelveElEquipo).toBe(false);
    expect(d.bloqueos[0].comoSeArregla).toContain("Renovar");
  });

  it("cuenta suspendida o cancelada bloquea y es del cliente", () => {
    for (const st of ["SUSPENDED", "CANCELLED"]) {
      const d = diagnosticarCuenta({ orgStatus: st, orgBrand: "conversia", vigencia: null, plan: PLAN_OK, suscripcion: null });
      expect(d.puedeCrear).toBe(false);
      expect(d.bloqueos[0].loResuelveElEquipo).toBe(false);
    }
  });
});

describe("avisos: molestan pero no bloquean", () => {
  it("un plan de OTRA marca se avisa sin bloquear (el caso del plan de TuBot)", () => {
    const d = diagnosticarCuenta({
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: true, motivo: "al_dia", validUntil: null, cubiertoHasta: null },
      plan: { code: "starter", name: "Starter", brand: "tubot", priceClp: 69900, active: true },
      suscripcion: { status: "ACTIVE", periodEnd: null },
    });
    expect(d.puedeCrear).toBe(true);
    expect(d.avisos.join(" ")).toContain("otra marca");
  });

  it("un plan retirado del catálogo se avisa sin bloquear", () => {
    const d = diagnosticarCuenta({
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: null,
      plan: { ...PLAN_OK, name: "Funcionando", active: false },
      suscripcion: null,
    });
    expect(d.puedeCrear).toBe(true);
    expect(d.avisos.join(" ")).toContain("ya no está activo");
  });

  it("sin plan asignado se avisa sin bloquear", () => {
    const d = diagnosticarCuenta({ orgStatus: "ACTIVE", orgBrand: "conversia", vigencia: null, plan: null, suscripcion: null });
    expect(d.puedeCrear).toBe(true);
    expect(d.avisos.join(" ")).toContain("plan gratuito");
  });

  it("una cuenta sana no inventa bloqueos ni avisos", () => {
    const d = diagnosticarCuenta({
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: true, motivo: "al_dia", validUntil: "2027-01-01T00:00:00.000Z", cubiertoHasta: null },
      plan: PLAN_OK,
      suscripcion: { status: "ACTIVE", periodEnd: "2027-01-01T00:00:00.000Z" },
    });
    expect(d.puedeCrear).toBe(true);
    expect(d.bloqueos).toEqual([]);
    expect(d.avisos).toEqual([]);
    expect(d.resumen).toContain("condiciones de operar");
  });
});

describe("el prompt manda llamarla (si no, la herramienta existe y nadie la usa)", () => {
  const svc = new AssistantService({} as never, {} as never);
  const PROMPT_COPILOTO = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    true,
    "/canales",
  );

  it("ante «no me deja» la llama ANTES de responder", () => {
    expect(PROMPT_COPILOTO).toContain("estadoDeCuenta");
    expect(PROMPT_COPILOTO).toContain("NO ME DEJA");
    expect(PROMPT_COPILOTO).toMatch(/estadoDeCuenta ANTES de responder/);
  });

  it("prohíbe mandarlo a pagar cuando el bloqueo es nuestro", () => {
    expect(PROMPT_COPILOTO).toContain("loResuelveElEquipo");
    expect(PROMPT_COPILOTO).toMatch(/NO le pidas que pague/);
  });

  it("si la cuenta está bien, deriva al diagnóstico del canal", () => {
    expect(PROMPT_COPILOTO).toMatch(/"puedeCrear" es true[\s\S]{0,120}estadoCanales/);
  });
});
