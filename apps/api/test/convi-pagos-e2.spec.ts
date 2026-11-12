import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssistantService } from "../src/assistant/assistant.service";
import { runSetupTool, setupToolSpecs, textoDeRecargaAutomatica, resumirCreditos, type SetupToolCtx } from "../src/assistant/setup-tools";
import { sanitizeActions } from "../src/assistant/actions";
import { confirmaciones, confirmacionValida, pedirConfirmacion, TTL_CONFIRMACION_MS } from "../src/assistant/confirmaciones";
import { diagnosticarCuenta } from "../src/assistant/setup-logic";
import type { PrismaService } from "../src/prisma.service";

/**
 * E2 — CUENTA, VIGENCIA, PAGOS Y CRÉDITOS: Convi lo RESUELVE.
 *
 * El escenario que lo motivó (captura del 11-nov): cuenta con la prueba vencida.
 *   Dueño: «el asistente no responde»
 *   Convi: «He informado tu caso al equipo para que te ayuden con la renovación».
 *   Dueño: «ok» → «no puedo probar el asistente porque la vigencia del servicio ha vencido».
 *
 * Las dos respuestas están mal por razones distintas: la primera escala algo que se resuelve
 * con un botón de pago, y la segunda es, directamente, un defecto (la prueba usaba la regla
 * vieja de vigencia).
 */

const prismaFalso = {} as PrismaService;
const ctxBase = (cobros?: SetupToolCtx["cobros"]): SetupToolCtx => ({
  organizationId: "org1",
  userId: "u1",
  cobros,
});

beforeEach(() => confirmaciones._limpiar());

describe("las herramientas de cobro existen y están bien declaradas", () => {
  const specs = setupToolSpecs();
  const todas = [...specs.read, ...specs.write];

  it("las de PAGO son de escritura: no las puede usar quien no tiene permiso de cobros", () => {
    for (const n of ["generarEnlaceDePago", "activarRecargaAutomatica", "desactivarRecargaAutomatica", "reactivarSuscripcion"]) {
      expect(specs.write.some((s) => s.name === n), `${n} debe ser de escritura`).toBe(true);
    }
  });

  it("las de CONSULTA son de lectura", () => {
    for (const n of ["estadoDeCreditos", "verHistorialDeCobros"]) {
      expect(specs.read.some((s) => s.name === n), `${n} debe ser de lectura`).toBe(true);
    }
  });

  it("el tope mensual es OBLIGATORIO para activar la recarga automática", () => {
    const spec = todas.find((s) => s.name === "activarRecargaAutomatica")!;
    expect((spec.inputJsonSchema as { required?: string[] }).required).toContain("topeMensualClp");
  });

  it("todos los nombres siguen siendo ASCII (OpenAI rechaza la petición entera si no)", () => {
    for (const s of todas) expect(s.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("generarEnlaceDePago entrega el enlace REAL, no una pantalla", () => {
  it("devuelve el botón con la URL del proveedor y el monto que vino de la herramienta", async () => {
    const cobros = {
      checkout: vi.fn(async () => ({ url: "https://pago.flow.cl/abc", amount: 24990, currency: "CLP", provider: "flow" })),
    } as unknown as SetupToolCtx["cobros"];
    const r = await runSetupTool(prismaFalso, ctxBase(cobros), "generarEnlaceDePago", { tipo: "plan" });
    expect(r?.didWrite).toBe(true);
    const payload = JSON.parse(r!.content);
    expect(payload.url).toBe("https://pago.flow.cl/abc");
    expect(payload.monto).toBe(24990);
    expect(r!.actions?.[0]).toMatchObject({ type: "button", kind: "externo", payload: "https://pago.flow.cl/abc" });
  });

  it("un pack de créditos usa el camino de packs, no el del plan", async () => {
    const buyPackage = vi.fn(async () => ({ url: "https://pago.flow.cl/pack", amount: 49900 }));
    const cobros = { buyPackage, checkout: vi.fn() } as unknown as SetupToolCtx["cobros"];
    await runSetupTool(prismaFalso, ctxBase(cobros), "generarEnlaceDePago", { tipo: "pack", packCode: "conversia-cred-880" });
    expect(buyPackage).toHaveBeenCalledWith({ packCode: "conversia-cred-880" });
  });

  it("SIN proveedor configurado lo dice y lleva a Cobros, en vez de un botón que no lleva a nada", async () => {
    const cobros = { checkout: vi.fn(async () => ({ amount: 24990 })) } as unknown as SetupToolCtx["cobros"];
    const r = await runSetupTool(prismaFalso, ctxBase(cobros), "generarEnlaceDePago", { tipo: "plan" });
    expect(JSON.parse(r!.content).sinEnlace).toBe(true);
    expect(r!.actions?.[0]).toMatchObject({ kind: "interno", payload: "/cobros" });
  });

  it("si el proveedor falla, el error llega al dueño recortado y NO se inventa un enlace", async () => {
    const cobros = { checkout: vi.fn(async () => { throw new Error("Flow: tarjeta rechazada"); }) } as unknown as SetupToolCtx["cobros"];
    const r = await runSetupTool(prismaFalso, ctxBase(cobros), "generarEnlaceDePago", { tipo: "plan" });
    expect(r!.isError).toBe(true);
    expect(r!.content).toContain("tarjeta rechazada");
    expect(r!.actions ?? []).toEqual([]);
  });
});

describe("lo que cuesta dinero pasa por CONFIRMACIÓN", () => {
  it("activar la recarga NO ejecuta nada: devuelve una confirmación para leer", async () => {
    const setAutoRecharge = vi.fn();
    const cobros = { setAutoRecharge } as unknown as SetupToolCtx["cobros"];
    const r = await runSetupTool(prismaFalso, ctxBase(cobros), "activarRecargaAutomatica", {
      packCode: "conversia-cred-880",
      umbral: 100,
      topeMensualClp: 30000,
    });
    expect(setAutoRecharge, "no debe tocar nada antes de confirmar").not.toHaveBeenCalled();
    expect(r!.actions?.[0]?.type).toBe("confirm");
  });

  it("el texto dice las TRES cifras que importan: qué, cuándo y el tope", () => {
    const t = textoDeRecargaAutomatica({ packCode: "conversia-cred-880", umbral: 100, topeMensualClp: 30000 });
    expect(t).toContain("conversia-cred-880");
    expect(t).toContain("100");
    expect(t).toContain("30.000");
  });

  it("sin tope mensual NO se puede activar (mismo criterio que el panel)", async () => {
    const r = await runSetupTool(prismaFalso, ctxBase({} as never), "activarRecargaAutomatica", { umbral: 100 });
    expect(r!.isError).toBe(true);
    expect(r!.content).toMatch(/tope/i);
  });

  it("reactivar la suscripción también confirma: vuelve a cobrar", async () => {
    const r = await runSetupTool(prismaFalso, ctxBase({} as never), "reactivarSuscripcion", {});
    expect(r!.actions?.[0]?.type).toBe("confirm");
  });

  it("apagar la recarga NO confirma: no cuesta nada y no borra nada", async () => {
    const setAutoRecharge = vi.fn(async () => ({}));
    const cobros = { setAutoRecharge } as unknown as SetupToolCtx["cobros"];
    const r = await runSetupTool(prismaFalso, ctxBase(cobros), "desactivarRecargaAutomatica", {});
    expect(setAutoRecharge).toHaveBeenCalledWith({ enabled: false });
    expect(r!.didWrite).toBe(true);
  });
});

describe("la confirmación vive en el SERVIDOR", () => {
  it("al navegador solo le viaja el id y el texto, nunca los argumentos", async () => {
    const c = await pedirConfirmacion({
      organizationId: "org1",
      userId: "u1",
      tool: "activarRecargaAutomatica",
      args: { topeMensualClp: 30000, packCode: "x" },
      texto: "Activar la recarga con tope de $30.000. ¿Confirmas?",
    });
    expect(Object.keys(c).sort()).toEqual(["id", "texto"]);
    expect(JSON.stringify(c)).not.toContain("30000");
  });

  it("se usa UNA SOLA VEZ: pulsar dos veces no cobra dos veces", async () => {
    const c = await pedirConfirmacion({ organizationId: "org1", userId: "u1", tool: "t", args: {}, texto: "texto de prueba" });
    expect(await confirmaciones.tomar(c.id)).not.toBeNull();
    expect(await confirmaciones.tomar(c.id)).toBeNull();
  });

  it("CADUCA a los 10 minutos: una confirmación de ayer no se ejecuta hoy", () => {
    const vieja = { id: "x", organizationId: "org1", userId: "u1", tool: "t", input: {}, texto: "t", creadaEn: Date.now() - TTL_CONFIRMACION_MS - 1 };
    expect(confirmacionValida(vieja, { organizationId: "org1", userId: "u1" })).toBe(false);
  });

  it("solo vale para QUIEN la pidió: otro usuario no puede dispararla", () => {
    const c = { id: "x", organizationId: "org1", userId: "u1", tool: "t", input: {}, texto: "t", creadaEn: Date.now() };
    expect(confirmacionValida(c, { organizationId: "org1", userId: "u1" })).toBe(true);
    expect(confirmacionValida(c, { organizationId: "org1", userId: "u2" })).toBe(false);
    expect(confirmacionValida(c, { organizationId: "org2", userId: "u1" })).toBe(false);
  });

  it("una confirmación inexistente no es válida", () => {
    expect(confirmacionValida(null, { organizationId: "org1", userId: "u1" })).toBe(false);
  });

  it("la acción `confirm` pasa la lista blanca (si no, el botón no llegaría a la pantalla)", () => {
    const limpias = sanitizeActions([{ type: "confirm", id: "a".repeat(12), texto: "Un texto suficientemente largo" }]);
    expect(limpias).toHaveLength(1);
  });
});

describe("el saldo se cuenta, no se inventa", () => {
  it("días que alcanzan = saldo / consumo diario de los últimos 7 días", () => {
    const r = resumirCreditos({ balance: 300, consumo7d: 70 }, { enabled: false });
    expect(r.consumoDiario).toBe(10);
    expect(r.diasQueAlcanzan).toBe(30);
  });

  it("SIN consumo medido no se inventa un pronóstico", () => {
    const r = resumirCreditos({ balance: 300, consumo7d: 0 }, null);
    expect(r.consumoDiario).toBeNull();
    expect(r.diasQueAlcanzan).toBeNull();
  });

  it("refleja si la recarga automática está activa y con qué tope", () => {
    const r = resumirCreditos({ balance: 10 }, { enabled: true, monthlyCapClp: 30000 });
    expect(r.recargaAutomatica).toBe(true);
    expect(r.topeMensualClp).toBe(30000);
  });
});

describe("ESCENARIO 1 — cuenta vencida: se resuelve, no se escala", () => {
  const vencida = {
    orgStatus: "ACTIVE",
    orgBrand: "conversia",
    vigencia: { vigente: false, motivo: "vencida", validUntil: "2026-11-03T00:00:00.000Z", cubiertoHasta: null },
    plan: { code: "conversia_creditos_trial", name: "Prueba", brand: "conversia", priceClp: 0, active: true },
    suscripcion: null,
  };

  it("el bloqueo es DEL CLIENTE y se arregla pagando: NO se escala", () => {
    const d = diagnosticarCuenta(vencida);
    expect(d.puedeCrear).toBe(false);
    expect(d.bloqueos[0].loResuelveElEquipo).toBe(false);
    expect(d.bloqueos[0].comoSeArregla).toMatch(/renovar/i);
  });

  it("la rama «vencida pero pagada» ya NO existe: desde #639 es inalcanzable", () => {
    // Una cuenta con la suscripción viva no puede estar vencida: `evaluarVigencia` manda.
    const d = diagnosticarCuenta({ ...vencida, suscripcion: { status: "ACTIVE", periodEnd: new Date(Date.now() + 86400000).toISOString() } });
    expect(d.bloqueos[0].loResuelveElEquipo).toBe(false);
  });

  it("la ÚNICA excepción que se escala es nuestra: pago registrado sin suscripción", () => {
    const d = diagnosticarCuenta({ ...vencida, pagoRegistradoSinSuscripcion: true });
    expect(d.bloqueos[0].loResuelveElEquipo).toBe(true);
    expect(d.bloqueos[0].que).toMatch(/pago registrado/i);
    expect(d.bloqueos[0].comoSeArregla).toBeNull();
  });
});

describe("el PROMPT le dice que resuelva, no que escale", () => {
  const svc = new AssistantService({} as never, {} as never);
  const prompt = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    true,
    "/inicio",
  );

  it("tiene el bloque de cuenta y pagos", () => {
    expect(prompt).toContain("CUENTA Y PAGOS");
  });

  it("le prohíbe la frase exacta que dijo en la captura", () => {
    expect(prompt).toMatch(/He informado tu caso al equipo/i);
    expect(prompt).toMatch(/no puedo probar el asistente/i);
  });

  it("le dice que ofrezca el enlace de pago real", () => {
    expect(prompt).toContain("generarEnlaceDePago");
    expect(prompt).toMatch(/Pagar ahora/);
  });

  it("le prohíbe inventar montos", () => {
    expect(prompt).toMatch(/NUNCA inventes precios ni montos/i);
  });

  it("deja UNA sola excepción para escalar, y es la nuestra", () => {
    expect(prompt).toMatch(/loResuelveElEquipo/);
    expect(prompt).toMatch(/UNICA excepcion|ÚNICA excepción/i);
  });

  it("manda REVALIDAR con la herramienta antes de afirmar que quedó listo", () => {
    expect(prompt).toMatch(/REVALIDA/i);
  });
});
